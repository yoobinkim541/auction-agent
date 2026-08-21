begin;

create table if not exists gm_decision_events (
  id bigint generated always as identity primary key,
  listing_id bigint not null references gm_listings(id) on delete cascade,
  decision text not null check (decision in ('reviewing','favorite','hold','fieldwork','bid_review','rejected')),
  reason_code text,
  note text not null default '',
  target_bid bigint,
  precision_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists gm_decision_events_listing_created_idx
  on gm_decision_events (listing_id, created_at desc, id desc);

create or replace view gm_current_decisions as
  select distinct on (listing_id)
         id, listing_id, decision, reason_code, note, target_bid, precision_snapshot, created_at
    from gm_decision_events
   order by listing_id, created_at desc, id desc;

create or replace view gm_decision_preference_summary as
  with totals as (
    select count(*)::int as sample_size
      from gm_decision_events
  )
  select e.decision,
         e.reason_code,
         count(*)::int as event_count,
         totals.sample_size,
         (totals.sample_size >= 50) as eligible_for_personalization
    from gm_decision_events e
   cross join totals
   group by e.decision, e.reason_code, totals.sample_size;

commit;
