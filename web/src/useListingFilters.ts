import { useCallback, useEffect, useState } from 'react';
import type { SortKey } from './filters.ts';
import { loadUIState, saveUIState } from './persistence.ts';

export const SORT_DEFAULT_DIR: Record<SortKey, 'asc' | 'desc'> = {
  score: 'desc',
  safety: 'desc',
  trueSafety: 'desc',
  sale: 'asc',
  price: 'asc',
  appraisal: 'desc',
  assumed: 'asc',
  gap: 'asc',
  fieldwork: 'desc',
  competition: 'desc',
};

export function nextSortDirection(
  currentSort: SortKey,
  targetKey: SortKey,
  currentDir: 'asc' | 'desc',
): 'asc' | 'desc' {
  if (currentSort === targetKey) {
    return currentDir === 'asc' ? 'desc' : 'asc';
  }
  return SORT_DEFAULT_DIR[targetKey];
}


export function useListingFilters() {
  const [onlyPassed, setOnlyPassed] = useState<boolean>(() => loadUIState().onlyPassed ?? false);
  const [onlyFavorite, setOnlyFavorite] = useState(false);
  const [onlyDecided, setOnlyDecided] = useState(false);
  const [onlyMultiRound, setOnlyMultiRound] = useState<boolean>(() => loadUIState().onlyMultiRound ?? false);
  const [onlyZeroPi, setOnlyZeroPi] = useState(false);
  const [onlyConsider, setOnlyConsider] = useState(false);
  const [onlyPassedAvoid, setOnlyPassedAvoid] = useState(false);
  const [onlyUrgent, setOnlyUrgent] = useState(false);
  const [onlyToday, setOnlyToday] = useState(false);
  const [filterDate, setFilterDate] = useState<string | null>(null);
  const [maxGapEok, setMaxGapEok] = useState(0);
  const [hideExpired, setHideExpired] = useState<boolean>(() => loadUIState().hideExpired ?? true);
  const [hideIncomplete, setHideIncomplete] = useState<boolean>(() => loadUIState().hideIncomplete ?? false);
  const [type, setType] = useState<string>(() => loadUIState().type ?? 'all');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortKey>(() => loadUIState().sort ?? 'score');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>(() => loadUIState().sortDir ?? 'desc');
  const [groupByCase, setGroupByCase] = useState<boolean>(() => loadUIState().groupByCase ?? false);

  useEffect(() => {
    saveUIState({
      sort,
      sortDir,
      type,
      hideExpired,
      onlyPassed,
      onlyMultiRound,
      hideIncomplete,
      groupByCase,
    });
  }, [sort, sortDir, type, hideExpired, onlyPassed, onlyMultiRound, hideIncomplete, groupByCase]);

  const handleSort = useCallback(
    (key: SortKey) => {
      setSortDir((d) => nextSortDirection(sort, key, d));
      setSort(key);
    },
    [sort],
  );

  return {
    onlyPassed,
    setOnlyPassed,
    onlyFavorite,
    setOnlyFavorite,
    onlyDecided,
    setOnlyDecided,
    onlyMultiRound,
    setOnlyMultiRound,
    onlyZeroPi,
    setOnlyZeroPi,
    onlyConsider,
    setOnlyConsider,
    onlyPassedAvoid,
    setOnlyPassedAvoid,
    onlyUrgent,
    setOnlyUrgent,
    onlyToday,
    setOnlyToday,
    filterDate,
    setFilterDate,
    maxGapEok,
    setMaxGapEok,
    hideExpired,
    setHideExpired,
    hideIncomplete,
    setHideIncomplete,
    type,
    setType,
    q,
    setQ,
    sort,
    setSort,
    sortDir,
    setSortDir,
    groupByCase,
    setGroupByCase,
    handleSort,
  };
}
