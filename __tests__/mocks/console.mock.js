import { vi } from 'vitest';

vi.spyOn(console, 'log').mockImplementation(() => null);
vi.spyOn(console, 'error').mockImplementation(() => null);