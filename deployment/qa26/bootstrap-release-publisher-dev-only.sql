-- Approved administrator-run bootstrap: DEV DATABASE ONLY.
-- Run from the Dev PostgreSQL superuser's own interactive psql session.
-- This is NOT an automatic migration and intentionally creates NO password.
-- Next, issue psql's interactive \password hi5_release_publisher and grant
-- LOGIN only after the password is stored in an approved secret manager.
BEGIN;
DO $bootstrap$
BEGIN
  IF current_database()<>'hi5central' THEN
    RAISE EXCEPTION 'Expected Dev database hi5central';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hi5_release_publisher') THEN
    RAISE EXCEPTION 'Publisher role already exists; review instead of resetting credentials';
  END IF;
  EXECUTE 'CREATE ROLE hi5_release_publisher NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 3 PASSWORD NULL';
END
$bootstrap$;
GRANT CONNECT ON DATABASE hi5central TO hi5_release_publisher;
GRANT USAGE ON SCHEMA public TO hi5_release_publisher;
GRANT SELECT (build_sha,version_label,title,summary,entries,status,requested_at,edited_by,published_at)
  ON TABLE public.hi5central_release_note_drafts TO hi5_release_publisher;
GRANT UPDATE (status,published_at)
  ON TABLE public.hi5central_release_note_drafts TO hi5_release_publisher;
REVOKE CREATE ON SCHEMA public FROM hi5_release_publisher;
COMMIT;
-- Verify exact rights:
SELECT
  rolname,rolcanlogin,rolsuper,rolcreaterole,rolcreatedb,rolinherit,
  has_table_privilege(rolname,'public.hi5central_release_note_drafts','INSERT') AS can_insert_notes,
  has_table_privilege(rolname,'public.hi5central_release_note_drafts','DELETE') AS can_delete_notes,
  has_column_privilege(rolname,'public.hi5central_release_note_drafts','status','UPDATE') AS can_ack_status,
  has_column_privilege(rolname,'public.hi5central_release_note_drafts','published_at','UPDATE') AS can_ack_time,
  has_column_privilege(rolname,'public.hi5central_release_note_drafts','summary','UPDATE') AS can_edit_summary,
  has_column_privilege(rolname,'public.hi5central_release_note_drafts','build_sha','SELECT') AS can_read_sha
FROM pg_roles WHERE rolname='hi5_release_publisher';
