import { z } from 'zod';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_JWT_LEGACY_SECRET: z.string().min(1).optional(),

  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  SWAGGER_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),

  // ===== Google Calendar (app -> Calendar sync) =====
  // Full service-account JSON as a single-line string. Leave empty to disable sync.
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().default(''),
  // Target calendar id (the shared "aerochartercancunflightplanner" calendar,
  // e.g. an email like info@vuelatour.com or a *@group.calendar.google.com id).
  GOOGLE_CALENDAR_ID: z.string().default(''),
  GOOGLE_CALENDAR_SYNC_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),

  // ===== Email (Resend) =====
  RESEND_API_KEY: z.string().default(''),
  RESEND_FROM: z
    .string()
    .default('Vuelatour Notificaciones <notificaciones@notify.vuelatour.com>'),

  // ===== pyservices (IA / visión) =====
  // Base URL del microservicio FastAPI. Vacío = visión por IA deshabilitada
  // (la captura cae a manual + sugerencia histórica).
  PYSERVICES_BASE_URL: z.string().default(''),
  // Token compartido (header X-Internal-Token). Debe coincidir con pyservices.
  INTERNAL_SHARED_TOKEN: z.string().default(''),
  PYSERVICES_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
});

export type EnvVars = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): EnvVars {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment variables:\n${issues}`);
  }
  return result.data;
}
