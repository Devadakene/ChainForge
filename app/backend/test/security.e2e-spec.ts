import { INestApplication, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import request from 'supertest';
import crypto from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { AppModule } from '../src/app.module';
import {
  buildCorsOptions,
  createCorsOriginValidator,
  createHelmetMiddleware,
  createRateLimiter,
} from '../src/common/security/security.module';

type TestAppOptions = {
  enableDocs: boolean;
};

const setEnvValue = (key: string, value: string | undefined) => {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
};

const createTestApp = async ({ enableDocs }: TestAppOptions) => {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication();

  app.setGlobalPrefix('api');
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: '1',
    prefix: 'v',
  });

  const configService = app.get(ConfigService);
  app.use(createHelmetMiddleware(configService));
  app.use(createCorsOriginValidator(configService));
  app.enableCors(buildCorsOptions(configService));
  app.use(createRateLimiter(configService));

  if (enableDocs) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('ChainForge API')
      .setVersion('1.0')
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api/docs', app, document);
  }

  await app.init();
  return app;
};

describe('Security (e2e)', () => {
  let app: INestApplication;

  const originalEnv = {
    API_RATE_LIMIT: process.env.API_RATE_LIMIT,
    THROTTLE_TTL: process.env.THROTTLE_TTL,
    CORS_ORIGINS: process.env.CORS_ORIGINS,
    CORS_ALLOW_CREDENTIALS: process.env.CORS_ALLOW_CREDENTIALS,
  };

  beforeAll(async () => {
    process.env.API_RATE_LIMIT = '1000';
    process.env.THROTTLE_TTL = '60000';
    process.env.CORS_ORIGINS = 'http://localhost:3000';
    process.env.CORS_ALLOW_CREDENTIALS = 'false';

    app = await createTestApp({ enableDocs: true });
  });

  afterAll(async () => {
    await app.close();

    setEnvValue('API_RATE_LIMIT', originalEnv.API_RATE_LIMIT);
    setEnvValue('THROTTLE_TTL', originalEnv.THROTTLE_TTL);
    setEnvValue('CORS_ORIGINS', originalEnv.CORS_ORIGINS);
    setEnvValue('CORS_ALLOW_CREDENTIALS', originalEnv.CORS_ALLOW_CREDENTIALS);
  });

  describe('Helmet Security Headers', () => {
    it('should have required security headers enabled (development mode)', async () => {
      const response = await request(app.getHttpServer()).get('/api/v1/health');

      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['x-frame-options']).toBe('DENY');
      expect(response.headers['referrer-policy']).toBe(
        'strict-origin-when-cross-origin',
      );
      expect(response.headers['cross-origin-resource-policy']).toBe(
        'same-origin',
      );
      expect(response.headers['x-dns-prefetch-control']).toBe('off');
      expect(response.headers['x-permitted-cross-domain-policies']).toBe(
        'none',
      );
      expect(response.headers['x-powered-by']).toBeUndefined();
      expect(response.headers['content-security-policy']).toBeUndefined();
    });

    it('should have production security headers in production mode', async () => {
      process.env.NODE_ENV = 'production';
      process.env.CORS_ORIGINS = 'https://api.chainforge.app';
      process.env.CORS_ALLOW_CREDENTIALS = 'false';

      const prodApp = await createTestApp({ enableDocs: false });
      const response = await request(prodApp.getHttpServer()).get(
        '/api/v1/health',
      );

      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['x-frame-options']).toBe('DENY');
      expect(response.headers['strict-transport-security']).toBeDefined();
      expect(response.headers['content-security-policy']).toBeDefined();
      expect(response.headers['cross-origin-opener-policy']).toBe(
        'same-origin',
      );

      await prodApp.close();

      // Reset to development
      process.env.NODE_ENV = 'development';
      process.env.CORS_ORIGINS = 'http://localhost:3000';
    });
  });

  describe('CORS Policy', () => {
    it('should allow request from whitelisted origin', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/health')
        .set('Origin', 'http://localhost:3000');

      expect(response.status).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBe(
        'http://localhost:3000',
      );
      expect(
        response.headers['access-control-allow-credentials'],
      ).toBeUndefined();
    });

    it('should block request from non-whitelisted origin', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/health')
        .set('Origin', 'http://malicious.com');

      expect(response.status).toBe(403);
      expect(response.text).toBe('Not allowed by CORS');
    });

    it('should handle preflight requests for allowed origins', async () => {
      const response = await request(app.getHttpServer())
        .options('/api/v1/health')
        .set('Origin', 'http://localhost:3000')
        .set('Access-Control-Request-Method', 'GET');

      expect(response.status).toBe(204);
      expect(response.headers['access-control-allow-origin']).toBe(
        'http://localhost:3000',
      );
    });
  });

  describe('Rate Limiting', () => {
    const windowMs = 1000;
    const initialNow = new Date('2025-01-01T00:00:00Z').getTime();
    let now = initialNow;
    let nowSpy: jest.SpyInstance;
    let rateLimitApp: INestApplication;

    beforeEach(async () => {
      process.env.API_RATE_LIMIT = '2';
      process.env.THROTTLE_TTL = windowMs.toString();
      process.env.CORS_ORIGINS = 'http://localhost:3000';
      process.env.CORS_ALLOW_CREDENTIALS = 'false';

      now = initialNow;
      nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
      rateLimitApp = await createTestApp({ enableDocs: true });
    });

    afterEach(async () => {
      await rateLimitApp.close();
      nowSpy.mockRestore();

      process.env.API_RATE_LIMIT = '1000';
      process.env.THROTTLE_TTL = '60000';
      process.env.CORS_ORIGINS = 'http://localhost:3000';
      process.env.CORS_ALLOW_CREDENTIALS = 'false';
    });

    it('should rate limit, include retry headers, and reset after the window passes', async () => {
      const server = rateLimitApp.getHttpServer();

      await request(server).get('/api/v1/');
      await request(server).get('/api/v1/');

      const limited = await request(server).get('/api/v1/');

      expect(limited.status).toBe(429);
      expect(limited.headers['retry-after']).toBeDefined();
      expect(limited.headers['ratelimit-limit']).toBeDefined();
      expect(limited.headers['ratelimit-reset']).toBeDefined();

      now += windowMs + 1;

      const resetResponse = await request(server).get('/api/v1/');
      expect(resetResponse.status).toBe(200);
    });

    it('should not rate limit health endpoints', async () => {
      const server = rateLimitApp.getHttpServer();

      for (let i = 0; i < 4; i += 1) {
        const response = await request(server).get('/api/v1/health');
        expect(response.status).toBe(200);
      }
    });

    it('should not rate limit docs endpoints', async () => {
      const server = rateLimitApp.getHttpServer();

      for (let i = 0; i < 4; i += 1) {
        const response = await request(server).get('/api/docs');
        expect(response.status).toBe(200);
      }
    });

    describe('Organization-based Rate Limiting', () => {
      let orgRateLimitApp: INestApplication;
      let prisma: any;

      const hashApiKey = (key: string) => {
        return crypto.createHash('sha256').update(key).digest('hex');
      };

      const cleanupDb = async () => {
        try {
          await prisma.apiKey.deleteMany({
            where: {
              orgId: { in: ['org-a', 'org-b'] },
            },
          });
          await prisma.organization.deleteMany({
            where: {
              id: { in: ['org-a', 'org-b'] },
            },
          });
        } catch {
          // ignore cleanup errors
        }
      };

      afterEach(async () => {
        if (orgRateLimitApp) {
          await orgRateLimitApp.close();
        }
      });

      it('should simulate 200 requests under org A and 200 under org B in parallel without tripping 429', async () => {
        process.env.API_RATE_LIMIT = '250';
        process.env.THROTTLE_TTL = '60000';
        orgRateLimitApp = await createTestApp({ enableDocs: false });
        prisma = orgRateLimitApp.get(PrismaService);

        await cleanupDb();

        await prisma.organization.create({ data: { id: 'org-a', name: 'Org A' } });
        await prisma.organization.create({ data: { id: 'org-b', name: 'Org B' } });

        await prisma.apiKey.create({
          data: {
            id: 'key-a',
            keyHash: hashApiKey('key-a-secret'),
            role: 'operator',
            orgId: 'org-a',
          },
        });
        await prisma.apiKey.create({
          data: {
            id: 'key-b',
            keyHash: hashApiKey('key-b-secret'),
            role: 'operator',
            orgId: 'org-b',
          },
        });

        const server = orgRateLimitApp.getHttpServer();

        // Run 200 requests for org A and 200 for org B in parallel
        const promisesA = Array.from({ length: 200 }).map(() =>
          request(server)
            .post('/api/v1/verification')
            .set('x-api-key', 'key-a-secret')
            .send({}),
        );
        const promisesB = Array.from({ length: 200 }).map(() =>
          request(server)
            .post('/api/v1/verification')
            .set('x-api-key', 'key-b-secret')
            .send({}),
        );

        const responsesA = await Promise.all(promisesA);
        const responsesB = await Promise.all(promisesB);

        for (const res of responsesA) {
          expect(res.status).not.toBe(429);
        }
        for (const res of responsesB) {
          expect(res.status).not.toBe(429);
        }

        await cleanupDb();
      });

      it('should trip 429 on the 51st request for a single org when limit is 50', async () => {
        process.env.API_RATE_LIMIT = '50';
        process.env.THROTTLE_TTL = '60000';
        orgRateLimitApp = await createTestApp({ enableDocs: false });
        prisma = orgRateLimitApp.get(PrismaService);

        await cleanupDb();

        await prisma.organization.create({ data: { id: 'org-a', name: 'Org A' } });
        await prisma.apiKey.create({
          data: {
            id: 'key-a',
            keyHash: hashApiKey('key-a-secret'),
            role: 'operator',
            orgId: 'org-a',
          },
        });

        const server = orgRateLimitApp.getHttpServer();

        // 50 requests should succeed or at least not 429
        for (let i = 0; i < 50; i++) {
          const res = await request(server)
            .post('/api/v1/verification')
            .set('x-api-key', 'key-a-secret')
            .send({});
          expect(res.status).not.toBe(429);
        }

        // 51st request should trip 429
        const limitedRes = await request(server)
          .post('/api/v1/verification')
          .set('x-api-key', 'key-a-secret')
          .send({});
        expect(limitedRes.status).toBe(429);

        await cleanupDb();
      });
    });
  });

  describe('Docs Endpoint', () => {
    it('should serve Swagger UI', async () => {
      const response = await request(app.getHttpServer()).get('/api/docs');

      expect(response.status).toBe(200);
      expect(response.text).toContain('Swagger UI');
    });
  });
});
