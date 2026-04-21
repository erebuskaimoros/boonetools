begin;

alter table public.rapid_swaps
  add column if not exists comparable_volume_usd double precision not null default 0;

update public.rapid_swaps
set comparable_volume_usd = round((
  case
    when upper(coalesce(source_asset, '')) = 'THOR.RUNE'
      or upper(coalesce(target_asset, '')) = 'THOR.RUNE'
      then
        case
          when coalesce(input_estimated_usd, 0) > 0 then coalesce(input_estimated_usd, 0)
          else coalesce(output_estimated_usd, 0)
        end
    when coalesce(input_estimated_usd, 0) > 0
      and coalesce(output_estimated_usd, 0) > 0
      then coalesce(input_estimated_usd, 0) + coalesce(output_estimated_usd, 0)
    when coalesce(input_estimated_usd, 0) > 0 then coalesce(input_estimated_usd, 0)
    else coalesce(output_estimated_usd, 0)
  end
)::numeric, 2)::double precision
where true;

create index if not exists rapid_swaps_comparable_volume_usd_idx
  on public.rapid_swaps (comparable_volume_usd desc, action_date desc);

commit;
