-- Unificación tarjeta↔usuario (26-ago): la FUENTE DE VERDAD del vínculo es
-- tarjeta_corporativa.usuario_id; usuario.tarjeta_terminacion queda como
-- ESPEJO derivado (lo mantienen cards.service/users.service en cada
-- escritura). Backfill de la divergencia actual, en dos pasos idempotentes:

-- 1) Espejo → FK: usuarios con terminación apuntando a una tarjeta ACTIVA
--    sin dueño (Caceres 0585, Abraham 0593) se vuelven su usuario vinculado.
update tarjeta_corporativa t
   set usuario_id = u.id
  from usuario u
 where u.tarjeta_terminacion = t.terminacion
   and t.activa
   and t.usuario_id is null;

-- 2) FK → espejo: toda tarjeta activa vinculada asegura el espejo del dueño.
update usuario u
   set tarjeta_terminacion = t.terminacion
  from tarjeta_corporativa t
 where t.usuario_id = u.id
   and t.activa
   and u.tarjeta_terminacion is distinct from t.terminacion;
