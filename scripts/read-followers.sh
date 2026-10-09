#!/usr/bin/env bash
# Reads Steam follower counts for the pages Publishing Ping says are due and
# reports them back. Run by .github/workflows/followers.yml, because
# steamcommunity.com rate-limits Vercel's servers.
#
# Steam allows roughly 50 reads from one machine, then answers HTTP 429 for
# about 10-13 minutes. When that happens this waits the block out (if
# MAX_SECONDS leaves time) and carries on, rather than retrying into it.
#
# Env: APP_URL, CRON_SECRET, MAX_SECONDS (how long to keep reading).
set -euo pipefail

: "${APP_URL:?}" "${CRON_SECRET:?}"
MAX_SECONDS=${MAX_SECONDS:-55}
BLOCK_WAIT=${BLOCK_WAIT:-600}  # seconds to wait after a 429 before trying again
auth="Authorization: Bearer $CRON_SECRET"
stop_at=$((SECONDS + MAX_SECONDS))
read_total=0
results='[]'

report() {
  [ "$results" = '[]' ] && return 0
  jq -c '{results: .}' <<<"$results" | curl --fail-with-body -sS -m 120 -H "$auth" \
    -H 'Content-Type: application/json' --data-binary @- "$APP_URL/api/followers" | jq -c 'del(.log)'
  results='[]'
}

time_left() { echo $((stop_at - SECONDS)); }

while [ "$(time_left)" -gt 0 ]; do
  ids=$(curl --fail-with-body -sS -m 60 -H "$auth" "$APP_URL/api/followers" | jq -r '.appids[]')
  [ -z "$ids" ] && { echo "Nothing due."; break; }
  echo "Pages due in this batch: $(wc -w <<<"$ids")"

  for id in $ids; do
    while :; do
      [ "$(time_left)" -le 0 ] && break 3
      rm -f body.xml
      code=$(curl -s -m 20 -o body.xml -w '%{http_code}' -A 'Mozilla/5.0 (compatible; PublishingPing/2.0)' \
        "https://steamcommunity.com/games/$id/memberslistxml/?xml=1") || true
      [ "$code" != 429 ] && break
      report  # save progress before waiting
      if [ "$(time_left)" -le "$BLOCK_WAIT" ]; then
        echo "Steam rate-limited at $id after $read_total reads; not enough time left to wait it out."
        break 3
      fi
      echo "Steam rate-limited at $id after $read_total reads; waiting $((BLOCK_WAIT / 60)) minutes."
      sleep "$BLOCK_WAIT"
    done

    count=$( { grep -so '<memberCount>[0-9]*' body.xml || true; } | head -1 | tr -dc 0-9)
    if [ "$code" = 200 ] && [ -n "$count" ]; then
      results=$(jq -c --argjson a "$id" --argjson f "$count" '. + [{appid: $a, followers: $f}]' <<<"$results")
      read_total=$((read_total + 1))
    else
      results=$(jq -c --argjson a "$id" --arg e "HTTP $code from steamcommunity.com" '. + [{appid: $a, error: $e}]' <<<"$results")
      echo "$id: failed (HTTP $code)"
    fi
    # Report in chunks so a cancelled run loses little.
    [ "$(jq length <<<"$results")" -ge 25 ] && report
    sleep 1
  done
  report
done

report
echo "Read $read_total follower counts in ${SECONDS}s."
