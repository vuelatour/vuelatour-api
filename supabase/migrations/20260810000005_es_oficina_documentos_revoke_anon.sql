-- es_oficina_documentos() queda expuesta como RPC de PostgREST. authenticated
-- DEBE conservar EXECUTE (las policies de storage la evalúan con ese rol al
-- subir/borrar), pero anon no tiene por qué invocarla (con auth.uid() null
-- solo regresa false; se revoca por higiene del advisor 0028).
revoke execute on function public.es_oficina_documentos() from anon, public;
