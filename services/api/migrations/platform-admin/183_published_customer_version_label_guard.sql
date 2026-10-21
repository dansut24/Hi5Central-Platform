-- Existing historical duplicate labels are preserved and can be repaired
-- by the authenticated, audited Platform Admin correction endpoint.
-- Every NEW label assignment, including via legacy publisher/operator paths,
-- is now unique. Advisory locking serialises concurrent transactions.
CREATE OR REPLACE FUNCTION h5c_guard_published_release_version_label()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.version_label IS NOT DISTINCT FROM OLD.version_label THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext('h5c-public-release-version'),
    hashtext(NEW.version_label)
  );

  IF EXISTS (
    SELECT 1 FROM hi5central_published_release_notes p
    WHERE p.version_label=NEW.version_label
      AND p.build_sha<>NEW.build_sha
  ) THEN
    RAISE EXCEPTION 'Hi5Central customer release number % is already published.',NEW.version_label
      USING ERRCODE='23505',CONSTRAINT='hi5central_published_version_label_unique';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS h5c_published_version_label_guard
  ON hi5central_published_release_notes;

CREATE TRIGGER h5c_published_version_label_guard
BEFORE INSERT OR UPDATE OF version_label ON hi5central_published_release_notes
FOR EACH ROW EXECUTE FUNCTION h5c_guard_published_release_version_label();
