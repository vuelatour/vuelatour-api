-- Tarea 4: coordenadas por aeropuerto para calcular millas náuticas
-- (distancia great-circle / Haversine) sin depender de APIs externas.

ALTER TABLE aeropuerto ADD COLUMN IF NOT EXISTS latitud numeric;
ALTER TABLE aeropuerto ADD COLUMN IF NOT EXISTS longitud numeric;

COMMENT ON COLUMN aeropuerto.latitud IS 'Latitud en grados decimales (WGS84). Para cálculo de NM great-circle.';
COMMENT ON COLUMN aeropuerto.longitud IS 'Longitud en grados decimales (WGS84). Para cálculo de NM great-circle.';

-- Seed de coordenadas de los aeropuertos/pistas en uso (Yucatán / Quintana Roo).
-- Mayores: fuentes oficiales. Pistas chicas (HOL/MHL/PTU): OurAirports.
UPDATE aeropuerto SET latitud = 21.0365,  longitud = -86.8771  WHERE iata = 'CUN';
UPDATE aeropuerto SET latitud = 20.5224,  longitud = -86.9256  WHERE iata = 'CZM';
UPDATE aeropuerto SET latitud = 20.9370,  longitud = -89.6577  WHERE iata = 'MID';
UPDATE aeropuerto SET latitud = 18.5047,  longitud = -88.3268  WHERE iata = 'CTM';
UPDATE aeropuerto SET latitud = 20.2117,  longitud = -87.5671  WHERE iata = 'TUL';
UPDATE aeropuerto SET latitud = 21.51820, longitud = -87.38360 WHERE iata = 'HOL';
UPDATE aeropuerto SET latitud = 18.75919, longitud = -87.69959 WHERE iata = 'MHL';
UPDATE aeropuerto SET latitud = 19.07590, longitud = -87.56050 WHERE iata = 'PTU';
