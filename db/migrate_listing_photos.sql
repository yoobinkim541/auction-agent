create table if not exists gm_listing_photos (
  id           bigint generated always as identity primary key,
  listing_id   bigint references gm_listings(id) on delete cascade,
  case_no      text not null,
  item_no      text not null default '1',
  source       text not null default 'courtauction',
  source_url   text not null,
  cache_path   text not null,
  public_url   text not null,
  content_hash text not null,
  status       text not null default 'active' check (status in ('active','deleted','failed')),
  delete_reason text,
  captured_at  timestamptz not null default now(),
  deleted_at   timestamptz,
  unique (listing_id, content_hash)
);
create index if not exists idx_gm_listing_photos_listing_active on gm_listing_photos (listing_id, status);
create index if not exists idx_gm_listing_photos_case_item on gm_listing_photos (case_no, item_no, status);
