-- Enforce: 1 device can only check in once per day PER TIPE (piket/bebas/acara).
-- Run this in Supabase SQL Editor (Project 5) after deploying frontend changes.
--
-- Notes:
-- - This uses a PARTIAL UNIQUE INDEX, so old rows without device_id will not block creation.
-- - If you already have duplicates (same tanggal + device_id), this will fail until you delete duplicates.

drop index if exists public.sekre_log_unique_device_per_day;

create unique index if not exists sekre_log_unique_device_per_day
on public.sekre_log (
  tanggal,
  (data->>'device_id'),
  (data->>'tipe')
)
where
  (data ? 'device_id')
  and coalesce(data->>'device_id','') <> '';
