begin;

create table if not exists public.tc_fee_dash_windows (
  id text primary key,
  window_start date not null,
  window_end date not null,
  window_label text not null,
  fee_bps numeric not null,
  tc_fees_usd numeric not null,
  global_exchange_volume_usd numeric not null,
  daily_median_fees_per_billion_usd numeric,
  daily_range_low_fees_per_billion_usd numeric,
  daily_range_high_fees_per_billion_usd numeric,
  source_label text not null default '',
  source_thread text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tc_fee_dash_windows_window_start_idx
  on public.tc_fee_dash_windows (window_start);

insert into public.tc_fee_dash_windows (
  id, window_start, window_end, window_label, fee_bps, tc_fees_usd,
  global_exchange_volume_usd, daily_median_fees_per_billion_usd,
  daily_range_low_fees_per_billion_usd, daily_range_high_fees_per_billion_usd,
  source_label, source_thread
)
values
  ('2025-09-02_2025-09-09', '2025-09-02', '2025-09-09', 'Sep 2-Sep 9', 10, 375700, 1033000000000, 273, 97, 711, 'chain-analysis fee table', '019e49b8-9d77-7dd2-9d1f-aab8bfbd39f2'),
  ('2025-09-09_2025-09-16', '2025-09-09', '2025-09-16', 'Sep 9-Sep 16', 25, 539000, 1180000000000, 329, 259, 923, 'chain-analysis fee table', '019e49b8-9d77-7dd2-9d1f-aab8bfbd39f2'),
  ('2025-09-16_2025-09-23', '2025-09-16', '2025-09-23', 'Sep 16-Sep 23', 10, 239400, 1225000000000, 176, 111, 316, 'chain-analysis fee table', '019e49b8-9d77-7dd2-9d1f-aab8bfbd39f2'),
  ('2025-09-23_2025-09-30', '2025-09-23', '2025-09-30', 'Sep 23-Sep 30', 1, 103500, 1242000000000, 90, 49, 106, 'chain-analysis fee table', '019e49b8-9d77-7dd2-9d1f-aab8bfbd39f2'),
  ('2025-09-30_2025-10-07', '2025-09-30', '2025-10-07', 'Sep 30-Oct 7', 15, 749000, 1479000000000, 314, 84, 1592, 'chain-analysis fee table', '019e49b8-9d77-7dd2-9d1f-aab8bfbd39f2'),
  ('2025-10-07_2025-10-14', '2025-10-07', '2025-10-14', 'Oct 7-Oct 14', 10, 459800, 1971000000000, 189, 129, 352, 'chain-analysis fee table', '019e49b8-9d77-7dd2-9d1f-aab8bfbd39f2'),
  ('2025-10-14_2025-10-21', '2025-10-14', '2025-10-21', 'Oct 14-Oct 21', 5, 317200, 1489000000000, 178, 57, 593, 'chain-analysis fee table', '019e49b8-9d77-7dd2-9d1f-aab8bfbd39f2'),
  ('2025-10-21_2025-10-28', '2025-10-21', '2025-10-28', 'Oct 21-Oct 28', 20, 592600, 1171000000000, 360, 141, 1221, 'chain-analysis fee table', '019e49b8-9d77-7dd2-9d1f-aab8bfbd39f2'),
  ('2025-10-28_2025-11-04', '2025-10-28', '2025-11-04', 'Oct 28-Nov 4', 10, 295600, 1220000000000, 198, 103, 439, 'chain-analysis fee table', '019e49b8-9d77-7dd2-9d1f-aab8bfbd39f2'),
  ('2025-11-04_2025-11-11', '2025-11-04', '2025-11-11', 'Nov 4-Nov 11', 15, 285800, 1470000000000, 187, 131, 213, 'chain-analysis fee table', '019e49b8-9d77-7dd2-9d1f-aab8bfbd39f2'),
  ('2025-11-11_2025-11-18', '2025-11-11', '2025-11-18', 'Nov 11-Nov 18', 5, 189300, 1354000000000, 77, 53, 126, 'chain-analysis fee table', '019e49b8-9d77-7dd2-9d1f-aab8bfbd39f2'),
  ('2025-11-18_2025-11-25', '2025-11-18', '2025-11-25', 'Nov 18-Nov 25', 10, 310400, 1303000000000, 194, 119, 412, 'chain-analysis fee table', '019e49b8-9d77-7dd2-9d1f-aab8bfbd39f2')
on conflict (id) do update
set window_start = excluded.window_start,
    window_end = excluded.window_end,
    window_label = excluded.window_label,
    fee_bps = excluded.fee_bps,
    tc_fees_usd = excluded.tc_fees_usd,
    global_exchange_volume_usd = excluded.global_exchange_volume_usd,
    daily_median_fees_per_billion_usd = excluded.daily_median_fees_per_billion_usd,
    daily_range_low_fees_per_billion_usd = excluded.daily_range_low_fees_per_billion_usd,
    daily_range_high_fees_per_billion_usd = excluded.daily_range_high_fees_per_billion_usd,
    source_label = excluded.source_label,
    source_thread = excluded.source_thread,
    updated_at = now();

commit;
