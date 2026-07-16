# Rate Limiting

ChainForge enforces rate limits to ensure API service availability, prevent abuse, and provide fair resource distribution.

## Granularity and Keys

Rate limiting key selection varies based on request authentication status:

1. **Organization-based Rate Limiting**:
   - If the request is authenticated with an API key containing an organization ID (`orgId`) set by `ApiKeyGuard` (making `request.org` present), the rate limiter buckets request counts by:
     `org:<orgId>`
   - This ensures that different organizations do not share rate limit quotas, preventing one organization's usage or DDoS attacks from blocking another.

2. **IP-based Rate Limiting (Fallback)**:
   - If the request is unauthenticated or has no associated organization ID, the rate limiter falls back to keying by the caller's IP address:
     `req.ips[0]` or `req.ip` or `anonymous`/`unknown`

## Guards and Middleware

Rate limiting is implemented at two levels:

- **Express Middleware (`createRateLimiter`)**:
  - Registered globally to rate limit unauthenticated and verification requests.
  - Dynamically retrieves `orgId` from the database if an `x-api-key` is supplied to ensure organization-specific limit thresholds are respected.
  
- **NestJS Guard (`AdaptiveRateLimitGuard`)**:
  - Global NestJS guard that provides adaptive rate limiting using Redis sliding windows.
  - Intercepts requests after `ApiKeyGuard` has run, extracting `(request as any).org` to determine the rate limiting key.
