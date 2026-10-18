-- Add the single explicitly audited staff release action to the fanout event
-- type constraint. All previous types remain permitted. No certification,
-- employee approval, stage authorization, pause or deployment changes.
DO $migration$
DECLARE definition text;
BEGIN
 SELECT pg_get_constraintdef(oid) INTO definition
 FROM pg_constraint WHERE conrelid='public.platform_release_fanout_events'::regclass
   AND conname='platform_release_fanout_events_event_type_check'
   AND contype='c';
 IF definition IS NULL THEN
  RAISE EXCEPTION 'Expected fanout event type constraint is missing';
 END IF;
 IF definition LIKE '%release_to_customers%' THEN
  RETURN;
 END IF;
 IF definition NOT LIKE '%approved%' OR definition NOT LIKE '%revoked%'
    OR definition NOT LIKE '%scan%' OR definition NOT LIKE '%failed%' THEN
  RAISE EXCEPTION 'Unrecognised event type constraint, refusing to replace it';
 END IF;
 ALTER TABLE public.platform_release_fanout_events
   DROP CONSTRAINT platform_release_fanout_events_event_type_check;
 ALTER TABLE public.platform_release_fanout_events
   ADD CONSTRAINT platform_release_fanout_events_event_type_check
   CHECK (event_type IN
     ('approved','revoked','scan','failed','release_to_customers'));
END
$migration$;
