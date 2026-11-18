-- 목록 응답(raw_json.pjbBuldList)에 건물 면적이 있는데 상세를 못 받아 area_m2가 빈 매물을 채운다.
-- crawler/normalize.ts parseExclusiveArea와 같은 규칙: ㎡ 앞 숫자를 모두 더한다(복층·일괄매각).
update gm_listings l
   set area_m2 = s.area
  from (
    select g.id, round(sum(replace(m[1], ',', '')::numeric), 4) as area
      from gm_listings g,
           regexp_matches(g.raw_json->>'pjbBuldList', '([0-9][0-9,]*(?:\.[0-9]+)?)\s*㎡', 'g') as m
     where g.area_m2 is null
     group by g.id
  ) s
 where l.id = s.id
   and s.area > 0;
