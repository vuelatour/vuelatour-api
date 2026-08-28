-- 28-ago-2026 · Operaciones por AEROPUERTO (revisión del equipo sobre los balances de agosto).
-- El libro manual desglosa la celda OPERACIONES por aeropuerto ("Op cun: X · Op mhl: Y"); la carga del 26-ago
-- había metido un solo 'Complemento OP' por vuelo (y restaba el TUA embebido, que el Excel NO cuenta como
-- operación). Aquí, con las notas de celda del Excel: (1) complementos que coinciden con una parte del Excel
-- se convierten en 'Op <IATA>'; (2) partes faltantes se crean con su aeropuerto; (3) complementos mal
-- calculados se retiran; (4) gastos existentes reciben `lugar` (IATA); (5) estacionamiento de autos y otros
-- viáticos que el Excel lista bajo PILOTO se reclasifican; (6) ground handling Honduras (USD) toma el TC del
-- Excel y pasa a FBO. Todo guardado por valor viejo (idempotente). Marcador: [CARGA-EXCEL-AGO28].

-- ===== #100 N621TX vtacp 2026-08-01 · Excel OP=221.97 nota='Op cun'
delete from gasto where id = '7c54cdde-d58e-41e8-9b85-535ace269305' and monto = 308.97 and notas like '[CARGA-EXCEL-AGO26] Complemento%';  -- complemento OP sustituido por partes por aeropuerto

-- ===== #101 VGV vtacp 2026-08-01 · Excel OP=147.94 nota='Op cun'
update gasto set lugar = 'CUN', updated_at = now() where id = 'de1de34e-8c8b-477c-b12a-f2fba2e34178' and lugar is null;

-- ===== #102 VGV vtflights 2026-08-02 · Excel OP=1073.98 nota='Op cun: 73.98 Op hol: 1000'
update gasto set lugar = 'CUN', updated_at = now() where id = '7ce793dd-7f49-4681-8171-fa3bed3af4db' and lugar is null;
update gasto set lugar = 'HOL', updated_at = now() where id = 'f29cd43c-b1e0-4fac-a02f-b5b346df24d0' and lugar is null;

-- ===== #104 N621TX vthernan 2026-08-03 · Excel OP=1230.1799999999998 nota='Op cun: 500.64 Op ctm: 729.54'
update gasto set lugar = 'CUN', updated_at = now() where id = '90397cfb-8e90-40c7-bc68-a933b1e61609' and lugar is null;
delete from gasto where id = '08463997-b15f-4253-bd97-648ac13fb7d8' and monto = 1129.54 and notas like '[CARGA-EXCEL-AGO26] Complemento%';  -- complemento OP sustituido por partes por aeropuerto

-- ===== #105 N990GG vtflyselect 2026-08-11 · Excel OP=251.68 nota='Op cun: 106.9 Op mid: 148.38'
-- aviso: nota OP no parseable o no cuadra con la celda (251.68): 'Op cun: 106.9 Op mid: 148.38' → sin cambios en OP
-- aviso: piloto: sistema 364.0 > Excel 314.0 (se conserva)

-- ===== #108 N621TX vtpalma 2026-08-02 · Excel OP=3390.88 nota='Op cun: 589.48 Op ptu: 2801.4'
update gasto set lugar = 'CUN', updated_at = now() where id = '0b1e8ffd-97ec-495d-aac3-e3ed7b4c78f2' and lugar is null;
update gasto set lugar = 'PTU', monto = 2801.4, notas = '[CARGA-EXCEL-AGO28] Op PTU · Excel vtpalma' || ' · antes: ' || notas, updated_at = now() where id = '8b26a394-9323-4b3e-ab96-148b0151fad1' and monto = 2801.4 and notas like '[CARGA-EXCEL-AGO26] Complemento%';

-- ===== #110 VGV vtcasasandra 2026-08-02 · Excel OP=1187.83 nota='Op cun: 187.83 Op hol: 1000'
update gasto set lugar = 'CUN', updated_at = now() where id = 'f449be3d-e8d2-4bd5-aee2-982a6d49d926' and lugar is null;
update gasto set lugar = 'HOL', updated_at = now() where id = '01e278d8-b537-4480-8b74-a3ef03e72fe2' and lugar is null;

-- ===== #111 VGV vtmartinez 2026-08-03 · Excel OP=175.5 nota='Op cun'
update gasto set lugar = 'CUN', updated_at = now() where id = 'd8de8a44-4416-428c-9ef6-1ccbf013502d' and lugar is null;
-- aviso: otros: sistema 140.0 > Excel 0.0 (se conserva)

-- ===== #112 VGV vtflights 2026-08-03 · Excel OP=1000 nota='Op hol'
update gasto set lugar = 'HOL', updated_at = now() where id = '1100af98-ac81-4354-ad3e-f245bc9eeaed' and lugar is null;

-- ===== #113 VGV vtflights 2026-08-04 · Excel OP=1193.6100000000001 nota='Op cun: 193.61 Op hol: 1000'
update gasto set lugar = 'CUN', updated_at = now() where id = '02a50788-70a3-451c-8ab0-81ed2b464c13' and lugar is null;
update gasto set lugar = 'HOL', updated_at = now() where id = '59c332ae-9511-4603-9a94-0a242985fb50' and lugar is null;

-- ===== #114 VGV vtrivera 2026-08-05 · Excel OP=180.22 nota='Op cun 180.22 tua 1891.19'

-- ===== #115 N990GG vtriviera 2026-08-05 · Excel OP=0 nota=''

-- ===== #116 VGV vtxomex 2026-08-06 · Excel OP=1197.46 nota='Op cun: 197.46 Op hol: 1000'
update gasto set lugar = 'CUN', updated_at = now() where id = '2744f663-1940-4cfa-a4ef-e6d1ac09eb9a' and lugar is null;
update gasto set lugar = 'HOL', updated_at = now() where id = '5da0ee29-69c0-42a5-bd07-656fd2190c84' and lugar is null;

-- ===== #117 VGV vtputterie 2026-08-05 · Excel OP=0 nota=''

-- ===== #118 N621TX vtsaker 2026-08-06 · Excel OP=1081.49 nota='Op cun: 892.76 Op czm; 188.73 tua 3443.88'
update gasto set lugar = 'CUN', updated_at = now() where id = 'b9fe3e83-e773-431b-9644-8cae0ccdcf86' and lugar is null;
-- aviso: OP NO cuadra: Excel [['CZM', 188.73]] (Σ188.73) vs sistema sin match [159.01] (Σ159.01) → revisar a mano

-- ===== #119 N990GG vtservicio 2026-08-06 · Excel OP=1342.3 nota='Op cun'
update gasto set lugar = 'CUN', updated_at = now() where id = '3cc3501b-e54f-4db8-8ceb-5d1d3a8de84e' and lugar is null;
delete from gasto where id = '94e9ab76-1d90-47fc-b014-a0b280e6667f' and monto = 670.0 and notas like '[CARGA-EXCEL-AGO26] Complemento%';  -- complemento OP sustituido por partes por aeropuerto

-- ===== #120 VGV vturiegas 2026-08-06 · Excel OP=349.06 nota='Op cun: 285.85 Op czm: 63.21'
update gasto set lugar = 'CZM', updated_at = now() where id = '2bc5feb1-7d5a-4e19-af3c-c3e6d7b61de4' and lugar is null;
update gasto set lugar = 'CUN', monto = 27.0, notas = '[CARGA-EXCEL-AGO28] Op CUN · Excel vturiegas · diferencia vs Excel: Excel CUN 285.85 vs sistema 258.85' || ' · antes: ' || notas, updated_at = now() where id = 'defb202b-d566-40ea-8ecf-b41e7b6a145f' and monto = 27.0 and notas like '[CARGA-EXCEL-AGO26] Complemento%';
-- aviso: OP: Excel [['CUN', 285.85]] vs sistema sin match [258.85] → complemento ajustado a $27.0

-- ===== #123 N621TX vtnelson 2026-08-07 · Excel OP=3347.55 nota='Op cun: 546.15 Op ptu: 2801.4'
update gasto set lugar = 'CUN', updated_at = now() where id = 'f2aa5953-ac9b-4627-8d2f-6dd33ce623eb' and lugar is null;
update gasto set lugar = 'PTU', monto = 2801.4, notas = '[CARGA-EXCEL-AGO28] Op PTU · Excel vtnelson' || ' · antes: ' || notas, updated_at = now() where id = '73a8d861-cc63-45c4-91d9-9aa064a26725' and monto = 2801.4 and notas like '[CARGA-EXCEL-AGO26] Complemento%';

-- ===== #124 N4142R vtservicio 2026-08-07 · Excel OP=3248.5800000000004 nota='Op mid'
update gasto set lugar = 'MID', updated_at = now() where id = '39609473-aabd-4532-a190-17927be239b7' and lugar is null;
update gasto set lugar = 'MID', updated_at = now() where id = 'd071e81b-b3be-484a-88f8-d50d4c21b76e' and lugar is null;
update gasto set categoria = 'TAXI', notas = coalesce(notas,'') || ' · [CARGA-EXCEL-AGO28] reclasificado de OPERACIONES → TAXI: estacionamiento de autos = viático (Excel piloto)', updated_at = now() where id = '94f907ff-1544-4e42-bbc1-cc1d4c3e6cb6' and categoria = 'OPERACIONES';
-- aviso: OP misma suma, partición distinta: Excel [['MID', 3248.58]] vs sistema [110.82, 3137.76]
-- aviso: piloto: sistema 1836.0 > Excel 1315.0 (se conserva)

-- ===== #125 N58BT vturiegas 2026-08-07 · Excel OP=1953.3899999999999 nota='Op cun: 1827.56 Op czm: 125.83 tua 430.48'
update gasto set lugar = 'CUN', updated_at = now() where id = '233b38b5-3e22-4fa0-8c65-807a61f98aac' and lugar is null;
update gasto set lugar = 'CZM', updated_at = now() where id = 'f0eb8b15-442a-45ee-8bbd-1de430b04286' and lugar is null;

-- ===== #126 PEV vtservicio 2026-08-07 · Excel OP=1441.95 nota='Op mid'
update gasto set lugar = 'MID', updated_at = now() where id = '8511fcd5-6e93-4598-bf96-3948253c5d98' and lugar is null;

-- ===== #127 VGV vtflights 2026-08-08 · Excel OP=1208.22 nota='Op cun: 208.22 Op hol: 1000'
update gasto set lugar = 'HOL', updated_at = now() where id = 'eca059d5-ecba-4a53-81de-1481b1354ac6' and lugar is null;
update gasto set lugar = 'CUN', updated_at = now() where id = '35f59a92-c726-4fbf-a8c9-f02d86cc3ff7' and lugar is null;
-- aviso: Op CUN $208.22: el Excel lo cuenta como operación y el sistema lo tiene en OTRO (se conserva)
-- aviso: otros: sistema 208.22 > Excel 0.0 (se conserva)

-- ===== #128 VGV vtputterie 2026-08-08 · Excel OP=1154.1399999999999 nota='Op cun: 154.14 Op hol: 1000'
update gasto set lugar = 'HOL', updated_at = now() where id = 'ca91bc46-d2d3-419f-a9a7-730bc5a09557' and lugar is null;
update gasto set lugar = 'CUN', updated_at = now() where id = '398a9021-e29e-4474-b69a-a9d9c408bcfb' and lugar is null;
-- aviso: Op CUN $154.14: el Excel lo cuenta como operación y el sistema lo tiene en OTRO (se conserva)
-- aviso: otros: sistema 154.14 > Excel 0.0 (se conserva)

-- ===== #129 N621TX vtacp 2026-08-08 · Excel OP=201.42 nota='Op cun'
delete from gasto where id = '8f090dcc-d662-4dd8-9fca-9a0ac704cdbf' and monto = 699.47 and notas like '[CARGA-EXCEL-AGO26] Complemento%';  -- complemento OP sustituido por partes por aeropuerto

-- ===== #130 PEV vtacp 2026-08-08 · Excel OP=94.53 nota='Op cun'
update gasto set lugar = 'CUN', monto = 94.53, notas = '[CARGA-EXCEL-AGO28] Op CUN · Excel vtacp' || ' · antes: ' || notas, updated_at = now() where id = 'cbc77206-6227-4886-bc00-a36ec206784a' and monto = 94.53 and notas like '[CARGA-EXCEL-AGO26] Complemento%';
-- aviso: sistema tiene ops que el Excel no lista: [127.27] (se conservan)

-- ===== #131 N621TX vtpalma 2026-08-09 · Excel OP=3289.12 nota='Op cun: 487.72 Op ptu: 2801.4'
update gasto set lugar = 'CUN', updated_at = now() where id = 'dd1f2924-af34-42ef-ae92-27f8ade1cf93' and lugar is null;
update gasto set lugar = 'PTU', monto = 2801.4, notas = '[CARGA-EXCEL-AGO28] Op PTU · Excel vtpalma' || ' · antes: ' || notas, updated_at = now() where id = 'd1701724-6413-42ce-a22d-2837d2971017' and monto = 2801.4 and notas like '[CARGA-EXCEL-AGO26] Complemento%';

-- ===== #132 N621TX vtriviera 2026-08-09 · Excel OP=536.11 nota='Op cun: 180.89 Op ctm: 355.22'
update gasto set lugar = 'CTM', monto = 355.22, notas = '[CARGA-EXCEL-AGO28] Op CTM · Excel vtriviera' || ' · antes: ' || notas, updated_at = now() where id = '85077ecd-8b37-4a20-9be6-38c719313094' and monto = 355.22 and notas like '[CARGA-EXCEL-AGO26] Complemento%';
update gasto set categoria = 'COMIDA', notas = coalesce(notas,'') || ' · [CARGA-EXCEL-AGO28] reclasificado de OPERACIONES → COMIDA: Excel piloto: Consumo piloto', updated_at = now() where id = '1e0a4289-7542-4a15-a4fe-b4f678664420' and categoria = 'OPERACIONES';
-- aviso: OP NO cuadra: Excel [['CUN', 180.89]] (Σ180.89) vs sistema sin match [450.0, 225.88] (Σ675.88) → revisar a mano

-- ===== #133 VGV vtacp 2026-08-09 · Excel OP=202.28 nota='Op cun'
update gasto set lugar = 'CUN', updated_at = now() where id = 'c10a1899-8795-4553-82bd-ae9cf07a4ec3' and lugar is null;

-- ===== #134 VGV vthernan 2026-08-10 · Excel OP=401.56 nota='Op cun: 159.04 TUA 1512.95 Op ctm: 242.52 TUA 939.60'
update gasto set lugar = 'CUN', updated_at = now() where id = '4397c3aa-c0cc-4079-9144-6d56140bf98a' and lugar is null;
update gasto set lugar = 'CTM', updated_at = now() where id = '1dc456f1-421c-4ea0-92fb-cc4f71b88376' and lugar is null;
update gasto set categoria = 'COMIDA', notas = coalesce(notas,'') || ' · [CARGA-EXCEL-AGO28] reclasificado de OTRO → COMIDA: Excel piloto: Consumo snack 75.0', updated_at = now() where id = '30ca8c46-0430-4d58-835c-3fa81cdfc5fd' and categoria = 'OTRO';
-- aviso: sistema tiene ops que el Excel no lista: [0.0] (se conservan)
-- aviso: otros: sistema 75.0 > Excel 0.0 (se conserva)

-- ===== #135 N621TX vtsaker 2026-08-10 · Excel OP=992.26 nota='Op cun: 668.83 Op czm: 323.43'
update gasto set lugar = 'CUN', updated_at = now() where id = '4ce297d3-71e1-4de4-85a8-91755873dccc' and lugar is null;
update gasto set lugar = 'CZM', updated_at = now() where id = '6dfaff99-85cf-4e5b-8d5a-2533d33d0c36' and lugar is null;
-- aviso: sistema tiene ops que el Excel no lista: [323.43] (se conservan)

-- ===== #137 VGV vtpalma 2026-08-11 · Excel OP=1300 nota='Op cun: 300 Op hol: 1000'
update gasto set lugar = 'HOL', updated_at = now() where id = 'b2cf757b-2e4c-4ff8-8c55-904ad8e3e7f9' and lugar is null;
delete from gasto where id = 'd3935f89-5256-4761-b9af-2d8b44428e19' and monto = 330.9 and notas like '[CARGA-EXCEL-AGO26] Complemento%';  -- complemento OP sustituido por partes por aeropuerto

-- ===== #138 N4142R vtflyselect 2026-08-11 · Excel OP=144.78 nota='Op mid'
-- aviso: OP NO cuadra: Excel [['MID', 144.78]] (Σ144.78) vs sistema sin match [148.38, 639.59] (Σ787.97) → revisar a mano
-- aviso: piloto: sistema 2759.0 > Excel 0.0 (se conserva)

-- ===== #139 N621TX vthernan 2026-08-11 · Excel OP=3219.35 nota='Op cun: 417.95 Op mhl: 2801.4'
delete from gasto where id = 'f86c98d9-118d-4160-9e79-3198ac925a98' and monto = 3219.35 and notas like '[CARGA-EXCEL-AGO26] Complemento%';  -- complemento OP sustituido por partes por aeropuerto
update gasto set categoria = 'TAXI', notas = coalesce(notas,'') || ' · [CARGA-EXCEL-AGO28] reclasificado de OPERACIONES → TAXI: estacionamiento de autos = viático (Excel piloto)', updated_at = now() where id = '8444b8f6-1c59-4c45-b515-f61a9554ac90' and categoria = 'OPERACIONES';

-- ===== #140 N4142R vtnaky 2026-08-12 · Excel OP=517.3 nota='Op cun: 283.81 Op ctm: 233.49'
update gasto set lugar = 'CUN', updated_at = now() where id = '7d9044f7-8479-4dd4-8daa-104f5b5cc2d8' and lugar is null;
update gasto set lugar = 'CTM', monto = 233.49, notas = '[CARGA-EXCEL-AGO28] Op CTM · Excel vtnaky' || ' · antes: ' || notas, updated_at = now() where id = 'c0b9cde3-3818-453a-820f-9a7257530d7b' and monto = 233.49 and notas like '[CARGA-EXCEL-AGO26] Complemento%';

-- ===== #141 N58BT vtsaab 2026-08-12 · Excel OP=1344.79 nota='Op cun: 1072.36 Op czm: 272.43'
update gasto set lugar = 'CUN', updated_at = now() where id = '242a43a6-0813-42f2-bd34-6b5558183b0b' and lugar is null;
update gasto set lugar = 'CZM', updated_at = now() where id = 'da0e59a1-9307-4696-a1ba-42ad15121562' and lugar is null;
delete from gasto where id = '6bd772cc-aacc-4062-8b20-673be21f628a' and monto = 11232.37 and notas like '[CARGA-EXCEL-AGO26] Complemento%';  -- complemento OP sustituido por partes por aeropuerto
update gasto set tc_gasto = 26.33, categoria = 'FBO', notas = coalesce(notas,'') || ' · [CARGA-EXCEL-AGO28] Excel otros: 33493.59 MXN = 1272.07 USD → TC 26.33, OPERACIONES → FBO', updated_at = now() where id = 'b4dc37da-5ecf-455c-bfe0-6e70f25f1b7d' and moneda = 'USD' and tc_gasto is null;

-- ===== #142 VGV vthernan 2026-08-12 · Excel OP=None nota=''

-- ===== #143 N58BT vtservicio 2026-08-13 · Excel OP=268.3 nota='Op cun'
update gasto set lugar = 'CUN', updated_at = now() where id = 'b3b79199-dc46-4e78-b52b-80904bb2950d' and lugar is null;

-- ===== #144 VGV vtmax 2026-08-13 · Excel OP=1238.35 nota='Op cun: 238.35 Op hol: 1000'
update gasto set lugar = 'CUN', updated_at = now() where id = '3eb89b89-a7fd-483e-8d4f-154b8c3131d8' and lugar is null;
update gasto set lugar = 'HOL', updated_at = now() where id = '59fcc1af-3f36-4ac6-93ca-65d77bc69d16' and lugar is null;

-- ===== #146 N621TX vtnelson 2026-08-14 · Excel OP=3710.31 nota='Op cun: 908.91 Op ptu: 2801.4'
update gasto set lugar = 'PTU', monto = 2801.4, notas = '[CARGA-EXCEL-AGO28] Op PTU · Excel vtnelson' || ' · antes: ' || notas, updated_at = now() where id = '16470dcc-567a-429e-afd3-9c124398e0f3' and monto = 2801.4 and notas like '[CARGA-EXCEL-AGO26] Complemento%';
-- aviso: OP NO cuadra: Excel [['CUN', 908.91]] (Σ908.91) vs sistema sin match [953.9] (Σ953.9) → revisar a mano

-- ===== #147 PEV vtfco 2026-08-14 · Excel OP=652.87 nota='Op cun'
update gasto set lugar = 'CUN', updated_at = now() where id = 'cfab9191-939f-4141-9378-74d1441b0aa1' and lugar is null;

-- ===== #149 VGV vtxomex 2026-08-14 · Excel OP=None nota=''
-- aviso: piloto: sistema 80.0 > Excel 0.0 (se conserva)
-- aviso: otros: sistema 80.0 > Excel 0.0 (se conserva)

-- ===== #150 N4142R vtalberti 2026-08-14 · Excel OP=464.68 nota='Op cun'
update gasto set lugar = 'CUN', updated_at = now() where id = '4f7e87c7-26a5-4ec3-bc6c-27a2449cbe99' and lugar is null;

-- ===== #151 N990GG vtfco 2026-08-14 · Excel OP=1573.7399999999998 nota='Op cun: 756.92 Op cza: 565.18 Op czm: 125.82 Op czm: 125.82 tua 1291.46'
update gasto set lugar = 'CUN', updated_at = now() where id = '2dbccde7-16c8-4505-967f-40b62895d250' and lugar is null;
update gasto set lugar = 'CZA', updated_at = now() where id = '01cb3b64-dd2e-49b5-bb7d-82aa6e427e09' and lugar is null;
update gasto set lugar = 'CZM', updated_at = now() where id = 'cdc64c91-fe8c-4d42-998e-554bafa345f5' and lugar is null;
update gasto set lugar = 'CZM', updated_at = now() where id = 'b76a5541-d8d3-427a-92c7-ca64251f53ff' and lugar is null;

-- ===== #152 N621TX vtacp 2026-08-15 · Excel OP=503.22 nota='Op cun'
update gasto set lugar = 'CUN', monto = 503.22, notas = '[CARGA-EXCEL-AGO28] Op CUN · Excel vtacp' || ' · antes: ' || notas, updated_at = now() where id = 'a6471d3a-2432-4df6-aef0-98f36edfd7c8' and monto = 503.22 and notas like '[CARGA-EXCEL-AGO26] Complemento%';
update gasto set categoria = 'TAXI', notas = coalesce(notas,'') || ' · [CARGA-EXCEL-AGO28] reclasificado de OPERACIONES → TAXI: estacionamiento de autos = viático (Excel piloto)', updated_at = now() where id = '96c1cb28-b44c-4999-b627-5ada35868250' and categoria = 'OPERACIONES';

-- ===== #153 PEV vtacp 2026-08-15 · Excel OP=753.7 nota='Op cun'
update gasto set lugar = 'CUN', updated_at = now() where id = 'e5e89be0-1cf2-4b07-805a-bab83d7ab7c1' and lugar is null;

-- ===== #154 VGV vtxflats 2026-08-15 · Excel OP=1281.0099999999998 nota='Op cun: 162.89 Tuas 756.48 Op mhl: 1118.12'
update gasto set lugar = 'CUN', updated_at = now() where id = 'fb32ef96-df3d-49f8-b8b2-bc0ecad4fcb6' and lugar is null;
update gasto set lugar = 'MHL', monto = 1118.12, notas = '[CARGA-EXCEL-AGO28] Op MHL · Excel vtxflats (el complemento del 26-ago restaba el TUA embebido)' || ' · antes: ' || notas, updated_at = now() where id = '260e076f-fa3f-41dc-b8e1-d3a1063a9dbf' and monto = 361.64 and notas like '[CARGA-EXCEL-AGO26] Complemento%';
-- aviso: OP: Excel [['MHL', 1118.12]] vs sistema sin match [0.0] → complemento ajustado a $1118.12

-- ===== #155 N621TX vtpalma 2026-08-16 · Excel OP=3299.4500000000003 nota='Op cun: 498.05 Op ptu: 2801.4'
update gasto set lugar = 'CUN', updated_at = now() where id = '2583a2ab-687c-41e6-b8a3-7d313026075c' and lugar is null;
update gasto set lugar = 'PTU', monto = 2801.4, notas = '[CARGA-EXCEL-AGO28] Op PTU · Excel vtpalma' || ' · antes: ' || notas, updated_at = now() where id = '9c236d2c-c4a7-4ea1-93bd-03c47a82201b' and monto = 2801.4 and notas like '[CARGA-EXCEL-AGO26] Complemento%';

-- ===== #156 VGV vtpalma 2026-08-16 · Excel OP=1160.85 nota='Op cun: 160.85 Op hol: 1000'
update gasto set lugar = 'CUN', updated_at = now() where id = '2adc9815-9820-4872-81d3-9b5fa924d14f' and lugar is null;
update gasto set lugar = 'HOL', updated_at = now() where id = '3071e93b-65d6-466f-b0f0-cf023164e57a' and lugar is null;

-- ===== #157 N990GG vtxflats 2026-08-16 · Excel OP=2763.25 nota='Op cun 531.88 Op mhl 2231.37'
update gasto set lugar = 'CUN', updated_at = now() where id = '9ab7ad74-953c-4403-a6ee-498b9a97bb9e' and lugar is null;
update gasto set lugar = 'MHL', monto = 2231.37, notas = '[CARGA-EXCEL-AGO28] Op MHL · Excel vtxflats' || ' · antes: ' || notas, updated_at = now() where id = '897c70bc-7a9d-4c16-84c2-287a0ce55db8' and monto = 2231.37 and notas like '[CARGA-EXCEL-AGO26] Complemento%';

-- ===== #159 N990GG vtalberti 2026-08-16 · Excel OP=537.61 nota='Op cun'
-- aviso: OP NO cuadra: Excel [['CUN', 537.61]] (Σ537.61) vs sistema sin match [602.45] (Σ602.45) → revisar a mano
-- aviso: piloto: sistema 2800.0 > Excel 0.0 (se conserva)

-- ===== #160 N621TX vtnelson 2026-08-16 · Excel OP=3002.82 nota='Op cun: 201.42 Op ptu: 2801.4'
update gasto set lugar = 'CUN', updated_at = now() where id = '3abd448f-3d48-4002-9bf2-79f94b88c2da' and lugar is null;
update gasto set lugar = 'PTU', monto = 2801.4, notas = '[CARGA-EXCEL-AGO28] Op PTU · Excel vtnelson · OJO: el sistema trae dos capturas de Op CUN $201.42 (posible duplicado) — revisar' || ' · antes: ' || notas, updated_at = now() where id = 'cfeaac55-e995-4abc-98ee-3437653e841a' and monto = 2599.98 and notas like '[CARGA-EXCEL-AGO26] Complemento%';
-- aviso: OP: Excel [['PTU', 2801.4]] vs sistema sin match [201.42] → complemento ajustado a $2599.98

-- ===== #161 VGV vtjetplanes 2026-08-17 · Excel OP=1163.43 nota='Op cun: 163.43 Op hol: 1000'
update gasto set lugar = 'CUN', updated_at = now() where id = '4f1a9968-b5f3-491e-b473-f3a64b640b86' and lugar is null;
update gasto set lugar = 'HOL', monto = 1000.0, notas = '[CARGA-EXCEL-AGO28] Op HOL · Excel vtjetplanes' || ' · antes: ' || notas, updated_at = now() where id = '5ef25097-59de-42e1-a749-8d8f7e5fe797' and monto = 1000.0 and notas like '[CARGA-EXCEL-AGO26] Complemento%';

-- ===== #162 VGV vtmax 2026-08-17 · Excel OP=1080.84 nota='Op cun: 80.84 Op hol: 1000'
update gasto set lugar = 'CUN', updated_at = now() where id = 'db61e907-f9e0-4c80-8c88-c6958d159a8a' and lugar is null;
update gasto set lugar = 'HOL', updated_at = now() where id = 'fed771f1-946a-40b9-b48d-bbf31925a535' and lugar is null;

-- ===== #163 N4142R vtmorenamia 2026-08-17 · Excel OP=254.12 nota='Op czm 254.12 tua 430.48'
update gasto set lugar = 'CZM', updated_at = now() where id = '7c0a9787-35d3-4434-bd51-2ba8f4f35cbc' and lugar is null;
update gasto set categoria = 'TAXI', notas = coalesce(notas,'') || ' · [CARGA-EXCEL-AGO28] reclasificado de OTRO → TAXI: Excel piloto: Gasolina pce 250.0', updated_at = now() where id = '0523a939-2ff0-44b6-9fe1-8e099bf1be78' and categoria = 'OTRO';
-- aviso: otros: sistema 250.0 > Excel 0.0 (se conserva)

-- ===== #164 VGV vtnono 2026-08-18 · Excel OP=2282.41 nota='Op cun: 164.29 Op fco: 1118.12 Op hol: 1000'
update gasto set lugar = 'CUN', updated_at = now() where id = 'c8db848c-4d2a-419a-a88c-cc951be2820d' and lugar is null;
update gasto set lugar = 'HOL', updated_at = now() where id = '1647dffc-bbe5-40f2-ad0a-f718a1ff72fc' and lugar is null;
-- aviso: piloto: sistema 512.0 > Excel 0.0 (se conserva)
-- aviso: otros: sistema 176.5 > Excel 0.0 (se conserva)

-- ===== #165 N621TX vturiega 2026-08-18 · Excel OP=1393.22 nota='Op cun: 858.1 Op czm: 535.12 tua 3013.40'
update gasto set lugar = 'CZM', updated_at = now() where id = '63819573-be74-45fd-8f8b-c5f0104656d8' and lugar is null;

-- ===== #168 N990GG vtsaab 2026-08-19 · Excel OP=752.4200000000001 nota='Op cun 626.6 Op czm 125.82'
update gasto set lugar = 'CUN', updated_at = now() where id = 'c346e682-d899-4881-8333-367a08ce55ac' and lugar is null;
update gasto set lugar = 'CZM', updated_at = now() where id = '0c5dd006-7ed7-4a47-9422-6a7c205b103a' and lugar is null;

-- ===== #169 PEV vthernan 2026-08-20 · Excel OP=1616.6 nota='Op cun: 498.48 Op mhl: 1118.12'
update gasto set lugar = 'CUN', updated_at = now() where id = 'a0ce58a0-9704-4b45-9840-395bd4c3300f' and lugar is null;
update gasto set lugar = 'MHL', monto = 1118.12, notas = '[CARGA-EXCEL-AGO28] Op MHL · Excel vthernan' || ' · antes: ' || notas, updated_at = now() where id = '143afa8a-35ae-4711-a22b-d9819db6f3c6' and monto = 1118.12 and notas like '[CARGA-EXCEL-AGO26] Complemento%';

-- ===== #170 N4142R vtnavyflex 2026-08-20 · Excel OP=0 nota=''

-- ===== #172 N990GG vtriviera 2026-08-20 · Excel OP=472.84 nota='Op cun'
update gasto set lugar = 'CUN', updated_at = now() where id = 'a1a03009-fe9e-4b7a-bf47-0a72d1a41577' and lugar is null;

-- ===== #173 N621TX vtnelson 2026-08-21 · Excel OP=3813.6800000000003 nota='Op cun: 1012.28 Op ptu: 2801.4'
delete from gasto where id = '233f3d5c-8c5e-40b9-98b8-d178d9391cea' and monto = 3813.68 and notas like '[CARGA-EXCEL-AGO26] Complemento%';  -- complemento OP sustituido por partes por aeropuerto

-- ===== #175 N990GG vtanapaty 2026-08-21 · Excel OP=397.38 nota='Op cun: 270.03 Op mid: 127.35'
update gasto set lugar = 'CUN', updated_at = now() where id = 'd3e264cc-9cb7-4918-b16a-2d4bf70bb846' and lugar is null;
update gasto set lugar = 'MID', updated_at = now() where id = 'b5848f7f-8635-41c8-84ea-ce9a8a33851a' and lugar is null;
update gasto set categoria = 'FBO', notas = coalesce(notas,'') || ' · [CARGA-EXCEL-AGO28] reclasificado de OPERACIONES → FBO: Excel otros: FBO MID por demora 1730.84', updated_at = now() where id = 'f6c684aa-a882-4d1d-aa69-2ea19beb4e2b' and categoria = 'OPERACIONES';
update gasto set categoria = 'OTRO', notas = coalesce(notas,'') || ' · [CARGA-EXCEL-AGO28] reclasificado de OPERACIONES → OTRO: Excel otros: Comisariato por demora 120.0', updated_at = now() where id = 'fab45352-4386-44f6-960e-c0953d462f66' and categoria = 'OPERACIONES';
-- aviso: sistema tiene ops que el Excel no lista: [1730.84, 120.0] (se conservan)

-- ===== #176 PEV vtxflats 2026-08-22 · Excel OP=214.25 nota='Op cun'
update gasto set lugar = 'CUN', updated_at = now() where id = '4bbba435-2bc4-47c0-b3b5-65aba88c196d' and lugar is null;

-- ===== #178 N621TX vtpaty 2026-08-22 · Excel OP=733.2900000000001 nota='Op cun: 544.57 Op czm: 188.72'
update gasto set lugar = 'CUN', updated_at = now() where id = 'b22087a1-c173-4a9b-9d91-bd164f4ace19' and lugar is null;
update gasto set lugar = 'CZM', updated_at = now() where id = '151a786f-1777-4b7a-b4d5-c2d339edc482' and lugar is null;

-- ===== #179 N621TX vtpalma 2026-08-23 · Excel OP=3379.32 nota='Op cun: 577.92 Op ptu: 2801.4'
update gasto set lugar = 'CUN', updated_at = now() where id = '9043b97b-e9b9-448c-bf57-0d29c273bd34' and lugar is null;
update gasto set lugar = 'PTU', monto = 2801.4, notas = '[CARGA-EXCEL-AGO28] Op PTU · Excel vtpalma' || ' · antes: ' || notas, updated_at = now() where id = '6700b10c-20f9-4b29-9d67-db5ab4b7cb92' and monto = 2801.4 and notas like '[CARGA-EXCEL-AGO26] Complemento%';

-- ===== #183 N4142R vtservicio 2026-08-24 · Excel OP=310.02 nota='Op cun 96.47 Op mid 213.55'
update gasto set lugar = 'CUN', updated_at = now() where id = '5e99cbf4-5fa9-470b-b498-0b5111d7d431' and lugar is null;
update gasto set lugar = 'MID', updated_at = now() where id = '3fa24c93-e5f9-43d3-85a1-2abac6d7787a' and lugar is null;
update gasto set categoria = 'TAXI', notas = coalesce(notas,'') || ' · [CARGA-EXCEL-AGO28] reclasificado de OTRO → TAXI: Excel piloto: Boleto ADO 718.0', updated_at = now() where id = 'b139f25b-38ac-4cba-a501-02768526c5d2' and categoria = 'OTRO';
update gasto set categoria = 'TAXI', notas = coalesce(notas,'') || ' · [CARGA-EXCEL-AGO28] reclasificado de OTRO → TAXI: Excel piloto: Uber FBO 280.0', updated_at = now() where id = '43422bd3-6dd0-4c74-80e5-a42a481ff931' and categoria = 'OTRO';
-- aviso: otros: sistema 998.0 > Excel 0.0 (se conserva)

-- ===== #189 N990GG vttejeda 2026-08-25 · Excel OP=1078.29 nota='Op cun: 797.14 Op ctm: 281.15'
update gasto set lugar = 'CUN', updated_at = now() where id = 'de69a7b0-65cb-4155-872f-db1bed5a345c' and lugar is null;
update gasto set lugar = 'CTM', monto = 281.15, notas = '[CARGA-EXCEL-AGO28] Op CTM · Excel vttejeda' || ' · antes: ' || notas, updated_at = now() where id = '46d1bf0d-b91f-499f-928c-ede44d6777c3' and monto = 281.15 and notas like '[CARGA-EXCEL-AGO26] Complemento%';
-- aviso: piloto: sistema 10282.0 > Excel 0.0 (se conserva)

-- ===== #196 N990GG vtservicio 2026-08-26 · Excel OP=359.62 nota='Op cun'
update gasto set lugar = 'CUN', updated_at = now() where id = '899f9666-095f-4ba6-9ac9-961029b812df' and lugar is null;
-- aviso: piloto: sistema 450.0 > Excel 0.0 (se conserva)

-- ===== Gastos nuevos (partes del Excel que el sistema no tenía) =====
insert into gasto (vuelo_id, aeronave_id, usuario_captura_id, categoria, monto, moneda, fecha_gasto, medio_pago, lugar, origen, notas, created_by, updated_by) values
('449f2700-70f7-4324-bdf8-eec9d476a9bb', 'e1a85e5b-9eaa-4367-9920-68d5d78883e8', '5391362f-e8cc-4287-95ef-739911fbf0e5', 'OPERACIONES', 221.97, 'MXN', '2026-08-01', 'TARJETA_CORP', 'CUN', 'OFICINA', '[CARGA-EXCEL-AGO28] Op CUN (Excel vtacp) · medio de pago por confirmar', '5391362f-e8cc-4287-95ef-739911fbf0e5', '5391362f-e8cc-4287-95ef-739911fbf0e5'),
('449f2700-70f7-4324-bdf8-eec9d476a9bb', 'e1a85e5b-9eaa-4367-9920-68d5d78883e8', '5391362f-e8cc-4287-95ef-739911fbf0e5', 'FBO', 87.0, 'MXN', '2026-08-01', 'TARJETA_CORP', 'CUN', 'OFICINA', '[CARGA-EXCEL-AGO28] Otros (Excel vtacp) · FBO CUN · medio de pago por confirmar', '5391362f-e8cc-4287-95ef-739911fbf0e5', '5391362f-e8cc-4287-95ef-739911fbf0e5'),
('394c01ed-5a66-4860-b066-14d5ff5b2642', 'e1a85e5b-9eaa-4367-9920-68d5d78883e8', '5391362f-e8cc-4287-95ef-739911fbf0e5', 'OPERACIONES', 729.54, 'MXN', '2026-08-03', 'TARJETA_CORP', 'CTM', 'OFICINA', '[CARGA-EXCEL-AGO28] Op CTM (Excel vthernan) · medio de pago por confirmar', '5391362f-e8cc-4287-95ef-739911fbf0e5', '5391362f-e8cc-4287-95ef-739911fbf0e5'),
('394c01ed-5a66-4860-b066-14d5ff5b2642', 'e1a85e5b-9eaa-4367-9920-68d5d78883e8', '5391362f-e8cc-4287-95ef-739911fbf0e5', 'COMIDA', 400.0, 'MXN', '2026-08-03', 'TARJETA_CORP', null, 'OFICINA', '[CARGA-EXCEL-AGO28] Viáticos (Excel vthernan): Consumo 280 + 120 · medio de pago por confirmar', '5391362f-e8cc-4287-95ef-739911fbf0e5', '5391362f-e8cc-4287-95ef-739911fbf0e5'),
('2d5578c4-65cb-48be-b2cb-6aef37b94ffc', '3d0546c3-941f-45cc-b8a9-e3ee77545e68', '5391362f-e8cc-4287-95ef-739911fbf0e5', 'OPERACIONES', 180.22, 'MXN', '2026-08-05', 'TARJETA_CORP', 'CUN', 'OFICINA', '[CARGA-EXCEL-AGO28] Op CUN (Excel vtrivera) · medio de pago por confirmar', '5391362f-e8cc-4287-95ef-739911fbf0e5', '5391362f-e8cc-4287-95ef-739911fbf0e5'),
('8173bb6f-909e-4eb5-8437-90c21a13a9e0', '8f37ec37-965a-42a8-bac4-9991d282f0a3', '5391362f-e8cc-4287-95ef-739911fbf0e5', 'TAXI', 250.0, 'MXN', '2026-08-06', 'TARJETA_CORP', null, 'OFICINA', '[CARGA-EXCEL-AGO28] Viáticos (Excel vtservicio): Gasolina 250 · medio de pago por confirmar', '5391362f-e8cc-4287-95ef-739911fbf0e5', '5391362f-e8cc-4287-95ef-739911fbf0e5'),
('8173bb6f-909e-4eb5-8437-90c21a13a9e0', '8f37ec37-965a-42a8-bac4-9991d282f0a3', '5391362f-e8cc-4287-95ef-739911fbf0e5', 'COMIDA', 420.0, 'MXN', '2026-08-06', 'TARJETA_CORP', null, 'OFICINA', '[CARGA-EXCEL-AGO28] Viáticos (Excel vtservicio): Consumo 420 · medio de pago por confirmar', '5391362f-e8cc-4287-95ef-739911fbf0e5', '5391362f-e8cc-4287-95ef-739911fbf0e5'),
('3bd311e2-dc01-4c2f-8d0e-ba55bad86297', 'e1a85e5b-9eaa-4367-9920-68d5d78883e8', '5391362f-e8cc-4287-95ef-739911fbf0e5', 'OPERACIONES', 201.42, 'MXN', '2026-08-08', 'TARJETA_CORP', 'CUN', 'OFICINA', '[CARGA-EXCEL-AGO28] Op CUN (Excel vtacp) · medio de pago por confirmar', '5391362f-e8cc-4287-95ef-739911fbf0e5', '5391362f-e8cc-4287-95ef-739911fbf0e5'),
('e2ab646a-919a-42fe-b750-25dbe4427b54', 'e1a85e5b-9eaa-4367-9920-68d5d78883e8', '5391362f-e8cc-4287-95ef-739911fbf0e5', 'OTRO', 44.99, 'MXN', '2026-08-09', 'TARJETA_CORP', 'CUN', 'OFICINA', '[CARGA-EXCEL-AGO28] Otros (Excel vtriviera): Serv deli cun 44.99 · medio de pago por confirmar', '5391362f-e8cc-4287-95ef-739911fbf0e5', '5391362f-e8cc-4287-95ef-739911fbf0e5'),
('892467ce-5573-449d-98e6-1c84cb6cd3ad', 'e1a85e5b-9eaa-4367-9920-68d5d78883e8', '5391362f-e8cc-4287-95ef-739911fbf0e5', 'FBO', 64.84, 'MXN', '2026-08-10', 'TARJETA_CORP', 'CUN', 'OFICINA', '[CARGA-EXCEL-AGO28] Otros (Excel vtsaker) · FBO CUN · medio de pago por confirmar', '5391362f-e8cc-4287-95ef-739911fbf0e5', '5391362f-e8cc-4287-95ef-739911fbf0e5'),
('b38e8951-1cd1-4588-b789-648680d03da6', '3d0546c3-941f-45cc-b8a9-e3ee77545e68', '5391362f-e8cc-4287-95ef-739911fbf0e5', 'OPERACIONES', 300.0, 'MXN', '2026-08-11', 'TARJETA_CORP', 'CUN', 'OFICINA', '[CARGA-EXCEL-AGO28] Op CUN (Excel vtpalma) · medio de pago por confirmar', '5391362f-e8cc-4287-95ef-739911fbf0e5', '5391362f-e8cc-4287-95ef-739911fbf0e5'),
('b38e8951-1cd1-4588-b789-648680d03da6', '3d0546c3-941f-45cc-b8a9-e3ee77545e68', '5391362f-e8cc-4287-95ef-739911fbf0e5', 'COMIDA', 30.9, 'MXN', '2026-08-11', 'TARJETA_CORP', null, 'OFICINA', '[CARGA-EXCEL-AGO28] Viáticos (Excel vtpalma) · Consumo piloto · medio de pago por confirmar', '5391362f-e8cc-4287-95ef-739911fbf0e5', '5391362f-e8cc-4287-95ef-739911fbf0e5'),
('51fc2176-3f83-42ec-aaf3-51c5943ece28', 'e1a85e5b-9eaa-4367-9920-68d5d78883e8', '5391362f-e8cc-4287-95ef-739911fbf0e5', 'OPERACIONES', 417.95, 'MXN', '2026-08-11', 'TARJETA_CORP', 'CUN', 'OFICINA', '[CARGA-EXCEL-AGO28] Op CUN (Excel vthernan) · medio de pago por confirmar', '5391362f-e8cc-4287-95ef-739911fbf0e5', '5391362f-e8cc-4287-95ef-739911fbf0e5'),
('51fc2176-3f83-42ec-aaf3-51c5943ece28', 'e1a85e5b-9eaa-4367-9920-68d5d78883e8', '5391362f-e8cc-4287-95ef-739911fbf0e5', 'OPERACIONES', 2801.4, 'MXN', '2026-08-11', 'TARJETA_CORP', 'MHL', 'OFICINA', '[CARGA-EXCEL-AGO28] Op MHL (Excel vthernan) · medio de pago por confirmar', '5391362f-e8cc-4287-95ef-739911fbf0e5', '5391362f-e8cc-4287-95ef-739911fbf0e5'),
('567dc4d1-803b-444e-9d12-cf79fcaa9915', '0caf610a-7989-4961-b473-988714719a5d', '5391362f-e8cc-4287-95ef-739911fbf0e5', 'FBO', 75.4, 'MXN', '2026-08-12', 'TARJETA_CORP', 'CUN', 'OFICINA', '[CARGA-EXCEL-AGO28] Otros (Excel vtsaab): FBO CUN 75.4 · medio de pago por confirmar', '5391362f-e8cc-4287-95ef-739911fbf0e5', '5391362f-e8cc-4287-95ef-739911fbf0e5'),
('3b2d7f7f-d24f-49ad-b596-0d5ddc1a0761', 'e1a85e5b-9eaa-4367-9920-68d5d78883e8', '5391362f-e8cc-4287-95ef-739911fbf0e5', 'OTRO', 44.99, 'MXN', '2026-08-14', 'TARJETA_CORP', null, 'OFICINA', '[CARGA-EXCEL-AGO28] Otros (Excel vtnelson) · Serv deli cun · medio de pago por confirmar', '5391362f-e8cc-4287-95ef-739911fbf0e5', '5391362f-e8cc-4287-95ef-739911fbf0e5'),
('7c62d47a-cb5e-4408-9fad-e8d151748f85', '8f37ec37-965a-42a8-bac4-9991d282f0a3', '5391362f-e8cc-4287-95ef-739911fbf0e5', 'OTRO', 64.84, 'MXN', '2026-08-16', 'TARJETA_CORP', null, 'OFICINA', '[CARGA-EXCEL-AGO28] Otros (Excel vtalberti) · Serv deli · medio de pago por confirmar', '5391362f-e8cc-4287-95ef-739911fbf0e5', '5391362f-e8cc-4287-95ef-739911fbf0e5'),
('b73888e3-8b50-4eda-aaf8-d2006c5858b8', '3d0546c3-941f-45cc-b8a9-e3ee77545e68', '5391362f-e8cc-4287-95ef-739911fbf0e5', 'OPERACIONES', 1118.12, 'MXN', '2026-08-18', 'TARJETA_CORP', 'FCO', 'OFICINA', '[CARGA-EXCEL-AGO28] Op FCO (Excel vtnono) · medio de pago por confirmar', '5391362f-e8cc-4287-95ef-739911fbf0e5', '5391362f-e8cc-4287-95ef-739911fbf0e5'),
('e8794063-42d1-47d6-911e-223598d049e4', 'e1a85e5b-9eaa-4367-9920-68d5d78883e8', '5391362f-e8cc-4287-95ef-739911fbf0e5', 'OPERACIONES', 858.1, 'MXN', '2026-08-18', 'TARJETA_CORP', 'CUN', 'OFICINA', '[CARGA-EXCEL-AGO28] Op CUN (Excel vturiega) · medio de pago por confirmar', '5391362f-e8cc-4287-95ef-739911fbf0e5', '5391362f-e8cc-4287-95ef-739911fbf0e5'),
('864b2fcd-5162-44c1-a1e7-682bf7d36056', 'e1a85e5b-9eaa-4367-9920-68d5d78883e8', '5391362f-e8cc-4287-95ef-739911fbf0e5', 'OPERACIONES', 1012.28, 'MXN', '2026-08-21', 'TARJETA_CORP', 'CUN', 'OFICINA', '[CARGA-EXCEL-AGO28] Op CUN (Excel vtnelson) · medio de pago por confirmar', '5391362f-e8cc-4287-95ef-739911fbf0e5', '5391362f-e8cc-4287-95ef-739911fbf0e5'),
('864b2fcd-5162-44c1-a1e7-682bf7d36056', 'e1a85e5b-9eaa-4367-9920-68d5d78883e8', '5391362f-e8cc-4287-95ef-739911fbf0e5', 'OPERACIONES', 2801.4, 'MXN', '2026-08-21', 'TARJETA_CORP', 'PTU', 'OFICINA', '[CARGA-EXCEL-AGO28] Op PTU (Excel vtnelson) · medio de pago por confirmar', '5391362f-e8cc-4287-95ef-739911fbf0e5', '5391362f-e8cc-4287-95ef-739911fbf0e5');