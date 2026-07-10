begin;

-- Remove rows accepted before Dune input validation required the claimed
-- Base Layer collector -> TC Reserve RESERVE path and an amount-matched RUNE coin.
delete from public.rujira_reserve_payment_events
where source = 'dune'
  and not (
    sender = 'thor1txum04wp8ykqudphxy9prtwsd9jpcm2kwdaxctxeeyr6g0r0we9qpfdktr'
    and recipient = 'thor1dheycdevq39qlkxs2a6wuuzyn4aqxhve4qxtxt'
    and memo = 'RESERVE'
    and amount_base > 0
    and case
      when btrim(coin) ~* '^([0-9]+)(rune|[[:space:]]+thor[.]rune)$'
        then (regexp_match(btrim(coin), '^([0-9]+)(rune|[[:space:]]+thor[.]rune)$', 'i'))[1]::numeric = amount_base
      else false
    end
  );

alter table public.rujira_reserve_payment_events
  drop constraint if exists rujira_reserve_payment_events_dune_path_check;

alter table public.rujira_reserve_payment_events
  add constraint rujira_reserve_payment_events_dune_path_check
  check (
    source <> 'dune'
    or (
      sender = 'thor1txum04wp8ykqudphxy9prtwsd9jpcm2kwdaxctxeeyr6g0r0we9qpfdktr'
      and recipient = 'thor1dheycdevq39qlkxs2a6wuuzyn4aqxhve4qxtxt'
      and memo = 'RESERVE'
      and amount_base > 0
      and case
        when btrim(coin) ~* '^([0-9]+)(rune|[[:space:]]+thor[.]rune)$'
          then (regexp_match(btrim(coin), '^([0-9]+)(rune|[[:space:]]+thor[.]rune)$', 'i'))[1]::numeric = amount_base
        else false
      end
    )
  );

commit;
