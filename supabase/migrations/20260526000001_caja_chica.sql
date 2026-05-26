-- Bloque 2: Caja chica y fondos (Modulo 5.5 del Diseno Funcional).
-- Fondo por persona; el saldo se calcula de los movimientos (reposiciones +,
-- reintegros -, ajustes +/-) menos los gastos en EFECTIVO de esa persona.
-- No se duplica el gasto aqui: la tabla gasto sigue siendo la fuente de verdad.

DO $$ BEGIN
  CREATE TYPE tipo_movimiento_caja AS ENUM ('REPOSICION', 'REINTEGRO', 'AJUSTE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS caja_chica_fondo (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id uuid NOT NULL UNIQUE REFERENCES usuario(id) ON DELETE CASCADE,
  moneda moneda NOT NULL DEFAULT 'MXN',
  activo boolean NOT NULL DEFAULT true,
  notas text,
  created_by uuid REFERENCES usuario(id),
  updated_by uuid REFERENCES usuario(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE caja_chica_fondo IS 'Bloque 2. Fondo de caja chica por persona (Modelo 1 pilotos/operativos, Modelo 2 Pablo/Ale).';
CREATE INDEX IF NOT EXISTS idx_caja_fondo_usuario ON caja_chica_fondo (usuario_id);
ALTER TABLE caja_chica_fondo ENABLE ROW LEVEL SECURITY;
DROP TRIGGER IF EXISTS trg_caja_fondo_set_updated_at ON caja_chica_fondo;
CREATE TRIGGER trg_caja_fondo_set_updated_at
  BEFORE UPDATE ON caja_chica_fondo
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

CREATE TABLE IF NOT EXISTS caja_chica_movimiento (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fondo_id uuid NOT NULL REFERENCES caja_chica_fondo(id) ON DELETE CASCADE,
  tipo tipo_movimiento_caja NOT NULL,
  monto numeric NOT NULL CHECK (monto <> 0),
  moneda moneda NOT NULL DEFAULT 'MXN',
  fecha date NOT NULL DEFAULT CURRENT_DATE,
  autorizado_por uuid REFERENCES usuario(id),
  referencia varchar(100),
  notas text,
  registrado_por uuid NOT NULL REFERENCES usuario(id),
  created_by uuid REFERENCES usuario(id),
  updated_by uuid REFERENCES usuario(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE caja_chica_movimiento IS 'Bloque 2. Cardex de caja chica: reposiciones (+), reintegros (-), ajustes (+/-). Los gastos EFECTIVO se descuentan del saldo desde la tabla gasto.';
CREATE INDEX IF NOT EXISTS idx_caja_mov_fondo ON caja_chica_movimiento (fondo_id, fecha);
ALTER TABLE caja_chica_movimiento ENABLE ROW LEVEL SECURITY;
DROP TRIGGER IF EXISTS trg_caja_mov_set_updated_at ON caja_chica_movimiento;
CREATE TRIGGER trg_caja_mov_set_updated_at
  BEFORE UPDATE ON caja_chica_movimiento
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
