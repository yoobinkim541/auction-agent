alter table gm_deonak_tenants
  add column if not exists item_no text not null default '1';

create index if not exists gm_deonak_tenants_case_item_idx
  on gm_deonak_tenants (case_no, item_no);
