import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadEnv } from '../src/common/utils/env-loader';

jest.mock('node:fs', () => ({
  existsSync: jest.fn(),
}));

jest.mock('dotenv', () => ({
  config: jest.fn(),
}));

import { config as dotenvConfig } from 'dotenv';

describe('loadEnv and Call Path Agreement', () => {
  const existsSyncMock = fs.existsSync as jest.Mock;
  const dotenvConfigMock = dotenvConfig as jest.Mock;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('should resolve process.cwd() / .env if it exists', () => {
    existsSyncMock.mockImplementation((p: string) => p === path.join(process.cwd(), '.env'));

    const result = loadEnv();

    expect(result).toBe(path.join(process.cwd(), '.env'));
    expect(dotenvConfigMock).toHaveBeenCalledWith({ path: path.join(process.cwd(), '.env') });
  });

  it('should fallback to app/backend/.env if process.cwd()/.env does not exist', () => {
    existsSyncMock.mockImplementation((p: string) => p === path.join(process.cwd(), 'app', 'backend', '.env'));

    const result = loadEnv();

    expect(result).toBe(path.join(process.cwd(), 'app', 'backend', '.env'));
    expect(dotenvConfigMock).toHaveBeenCalledWith({ path: path.join(process.cwd(), 'app', 'backend', '.env') });
  });

  it('should default to first candidate if none exist', () => {
    existsSyncMock.mockReturnValue(false);

    const result = loadEnv();

    expect(result).toBe(path.join(process.cwd(), '.env'));
    expect(dotenvConfigMock).not.toHaveBeenCalled();
  });

  it('asserts both call paths (main.ts loading and app.module.ts config path) agree on the final env state', () => {
    existsSyncMock.mockImplementation((p: string) => p === path.join(process.cwd(), 'app', 'backend', '.env'));

    const pathFromMainCall = loadEnv();
    const pathFromModuleCall = loadEnv();

    expect(pathFromMainCall).toEqual(pathFromModuleCall);
    expect(pathFromMainCall).toBe(path.join(process.cwd(), 'app', 'backend', '.env'));
  });
});
