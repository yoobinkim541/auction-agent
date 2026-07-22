-- Normalize missing listing item numbers to the canonical default item '1'.
-- Run once on existing DBs after deploying the code change.

alter table gm_listings alter column item_no set default '1';

-- Avoid unique(case_no,item_no,source) violations if both '' and '1' rows already exist.
-- Conflicting legacy '' rows are left untouched for manual review/deduplication.
update gm_listings l
   set item_no = '1'
 where l.item_no = ''
   and not exists (
     select 1
       from gm_listings other
      where other.case_no = l.case_no
        and other.source = l.source
        and other.item_no = '1'
        and other.id <> l.id
   );

-- Review any remaining rows; these likely need manual duplicate resolution.
select id, case_no, source, item_no, crawled_at
  from gm_listings
 where item_no = ''
 order by case_no, source, crawled_at desc nulls last;
