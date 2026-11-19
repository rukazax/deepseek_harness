#!/usr/bin/env bash
# dsh-memory-tune — biweekly accuracy/cost optimisation of dsh-memory-hub.
#
# What it does, in order:
#   1. takes a locked, consistent snapshot of the memory DB (VACUUM INTO, keep 3);
#   2. runs dsh-memory-tune.mjs, which scores the LIVE parameter set and a grid
#      of alternatives on labels derived from the store itself;
#   3. applies the tuned block into cordis.patch.yml only when the new settings
#      measurably beat the live ones on the same labels;
#   4. restarts dsh-web, waits for the HTTP API, and rolls the patch back if the
#      profile does not come up;
#   5. records the run in tune-history.jsonl + the store's meta and reports to
#      Telegram.
#
# Cadence: the timer fires nightly at 03:30; the script itself refuses to act
# until MIN_DAYS have passed since the last successful run, so the real cadence
# is exactly one optimisation every two weeks, in the night window, and a missed
# night self-heals on the next one.
#
# Flags: --force (ignore cadence), --dry-run (measure, print, change nothing),
#        --no-restart (write the patch but leave the running profile alone).

set -uo pipefail

PROFILE=/srv/apps/dsh/dsh-home/profiles/web
PATCH="$PROFILE/cordis.patch.yml"
DIR=/srv/apps/dsh/memory
SNAPS="$DIR/snapshots"
LOG="$DIR/tune.log"
HIST="$DIR/tune-history.jsonl"
LOCK="$DIR/tune.lock"
DB="$DIR/ctxdb.sqlite"
TUNER=/srv/apps/dsh/bin/dsh-memory-tune.mjs
SERVICE=dsh-web
MIN_DAYS=14
TS="$(date +%Y%m%d-%H%M%S)"
DAY="$(date '+%F %T')"

FORCE=0; DRY=0; NORESTART=0
for a in "$@"; do
  case "$a" in
    --force) FORCE=1 ;;
    --dry-run) DRY=1 ;;
    --no-restart) NORESTART=1 ;;
    *) echo "unknown flag: $a" >&2; exit 2 ;;
  esac
done

mkdir -p "$DIR" "$SNAPS"
log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*" | tee -a "$LOG"; }

TG_CHAT=${TG_CHAT:-418179821}
if [ -z "${TG_TOKEN:-}" ]; then
  TG_TOKEN=$(sed -n 's/^ *token: *//p' "$PATCH" 2>/dev/null | head -1 | tr -d '"' | tr -d "'")
fi
tg() { [ -n "${TG_TOKEN:-}" ] || return 0
  curl -s --max-time 25 -X POST "https://api.telegram.org/bot$TG_TOKEN/sendMessage" \
    --data-urlencode "chat_id=$TG_CHAT" --data-urlencode "text=$1" >/dev/null 2>&1; }

api_port() { sed -n 's/.*--port \([0-9]*\).*/\1/p' <<<"$(systemctl show dsh-web -p ExecStart --value)" | head -1; }
api_host() { sed -n 's/.*--host \([^ ]*\).*/\1/p' <<<"$(systemctl show dsh-web -p ExecStart --value)" | head -1; }

verify_profile() { # 0 when dsh-web is active and the memory API answers
  local waited=0 code=000 host port
  host="$(api_host)"; port="$(api_port)"
  [ -n "$host" ] || host=127.0.0.1; [ -n "$port" ] || port=8080
  systemctl is-active --quiet "$SERVICE" || return 1
  while [ "$waited" -lt 120 ]; do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 6 "http://$host:$port/api/memory-hub/stats" 2>/dev/null)
    [ "$code" = "200" ] && return 0
    sleep 3; waited=$((waited + 3))
  done
  return 1
}

restart_profile() { # restart + verify; non-zero when the profile is sick
  local before after
  before="$(systemctl show "$SERVICE" -p MainPID --value 2>/dev/null)"
  log "restarting $SERVICE (pid $before)"
  if ! systemctl restart "$SERVICE"; then
    log "systemctl restart refused — not applied (run as root, the timer service does)"
    return 2
  fi
  local waited=0
  while [ "$waited" -lt 60 ]; do
    after="$(systemctl show "$SERVICE" -p MainPID --value 2>/dev/null)"
    if [ -n "$after" ] && [ "$after" != "0" ] && [ "$after" != "$before" ]; then break; fi
    sleep 2; waited=$((waited + 2))
  done
  log "new pid $after"
  [ "$after" != "$before" ] || return 2
  verify_profile || return 1
  return 0
}

# ── single instance ─────────────────────────────────────────────────────────
exec 9>"$LOCK" || exit 1
flock -n 9 || { log "another run is in progress, exit"; exit 0; }

# ── cadence ─────────────────────────────────────────────────────────────────
LAST_EPOCH=0
if [ -s "$HIST" ]; then
  LAST_EPOCH=$(python3 - "$HIST" <<'PY'
import json,sys
last=0
for line in open(sys.argv[1]):
    line=line.strip()
    if not line: continue
    try: rec=json.loads(line)
    except Exception: continue
    if rec.get("applied"): last=max(last, int(rec.get("epoch",0)))
print(last)
PY
)
fi
NOW=$(date +%s)
AGE_D=$(( (NOW - LAST_EPOCH) / 86400 ))
if [ "$FORCE" -eq 0 ] && [ "$LAST_EPOCH" -gt 0 ] && [ "$AGE_D" -lt "$MIN_DAYS" ]; then
  log "cadence: last applied run ${AGE_D}d ago (< ${MIN_DAYS}d) — nothing to do"
  exit 0
fi
[ "$LAST_EPOCH" -gt 0 ] || AGE_D=-1
log "=== memory tune $DAY (last applied $( [ "$AGE_D" -lt 0 ] && echo never || echo "${AGE_D}d ago" ), force=$FORCE dry=$DRY) ==="

# ── snapshot ────────────────────────────────────────────────────────────────
SNAP="$SNAPS/ctxdb-$TS.sqlite"
if node -e "
const {DatabaseSync}=require('node:sqlite');
const d=new DatabaseSync(process.argv[1]);
d.exec(\"VACUUM INTO '\"+process.argv[2]+\"'\");
d.close();
" "$DB" "$SNAP" 2>>"$LOG"; then
  log "snapshot $SNAP ($(stat -c %s "$SNAP" 2>/dev/null) bytes)"
  ls -1t "$SNAPS"/ctxdb-*.sqlite 2>/dev/null | tail -n +4 | xargs -r rm -f
else
  log "snapshot failed — continuing without it"
  SNAP=""
fi

# ── measure ─────────────────────────────────────────────────────────────────
OUT=/tmp/dsh-memory-tune-$TS.json
if ! timeout 600 node "$TUNER" --db "$DB" --patch "$PATCH" --out "$OUT" >/dev/null 2>>"$LOG"; then
  log "tuner failed; see log"
  tg "memory-hub tune $DAY: тюнер упал, настройки не менялись. лог: $LOG"
  exit 1
fi

read -r VERDICT IMPROVE CUR_UTIL NEW_UTIL <<<"$(python3 - "$OUT" "$PATCH" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
cur=d.get("live",{}).get("metrics")
imp=d.get("improvement")
new=d.get("selectedBy",{}).get("pickedUtility",d.get("metrics",{}).get("objective",0))
cu=cur.get("utility") if cur else None
# apply only a real, non-trivial gain on identical labels
if cur is None or imp is None: verdict="no-baseline"
elif imp >= 0.02: verdict="apply"
else: verdict="keep"
print(verdict, imp if imp is not None else "none", cu if cu is not None else "none", new)
PY
)"
log "verdict=$VERDICT improvement=$IMPROVE currentUtility=$CUR_UTIL newUtility=$NEW_UTIL"

if [ "$VERDICT" != "apply" ]; then
  log "live settings already optimal on this data — patch untouched"
  python3 - "$OUT" "$HIST" "${SNAP:-}" "$DRY" <<'PY' 2>/dev/null
import json,sys,time
out,hist,snap,dry=sys.argv[1],sys.argv[2],sys.argv[3],sys.argv[4]
d=json.load(open(out))
rec={"at":d["at"],"epoch":int(time.time()),"applied":False,"reason":"no improvement",
     "improvement":d.get("improvement"),"live":d.get("live",{}).get("metrics"),
     "chosen":d.get("chosen"),"snapshot":snap,"dry_run":dry=="1"}
open(hist,"a").write(json.dumps(rec,ensure_ascii=False)+"\n")
PY
  if [ "$DRY" -eq 1 ]; then
    python3 -c "import json,sys; d=json.load(open('$OUT')); print(json.dumps({'live':d['live'],'chosen':d['chosen'],'metrics':d['metrics'],'improvement':d['improvement']},ensure_ascii=False,indent=2))"
  fi
  exit 0
fi

CHOSEN_JSON=$(python3 -c "import json;d=json.load(open('$OUT'));print(json.dumps(d['chosen']))")
log "chosen $CHOSEN_JSON"

if [ "$DRY" -eq 1 ]; then
  log "dry-run: not writing the patch"
  python3 -c "import json;d=json.load(open('$OUT'));print(json.dumps({'live':d['live'],'chosen':d['chosen'],'metrics':d['metrics'],'improvement':d['improvement']},ensure_ascii=False,indent=2))"
  exit 0
fi

# ── write the patch ─────────────────────────────────────────────────────────
BAK="$PATCH.bak-tune-$TS"
cp -a "$PATCH" "$BAK" || { log "cannot back up the patch"; exit 1; }
log "backup $BAK"

if ! python3 - "$PATCH" "$CHOSEN_JSON" "$OUT" <<'PY'
import json,sys,re
path,vals,out=sys.argv[1],json.loads(sys.argv[2]),sys.argv[3]
data=json.load(open(out))
lines=open(path,encoding="utf-8").read().split("\n")

# locate the memory-hub patch entry
start=None
for i,l in enumerate(lines):
    if re.match(r"^- id:\s*memory-hub\s*$", l): start=i; break
if start is None: sys.exit("memory-hub entry not found in patch")

end=len(lines)
for j in range(start+1,len(lines)):
    if re.match(r"^- id:", lines[j]): end=j; break

cfg=None
for j in range(start,end):
    if re.match(r"^\s+config:\s*$", lines[j]): cfg=j; break
if cfg is None: sys.exit("config block not found")

block=lines[start:end]
applied=[]
for key,value in vals.items():
    pat=re.compile(r"^(\s+)"+re.escape(key)+r":\s*[-0-9.]+\s*$")
    hit=None
    for j,l in enumerate(block):
        if pat.match(l): hit=j; break
    rendered=f"    {key}: {value}"
    if hit is not None:
        block[hit]=rendered
    else:
        block.append(rendered)
    applied.append(key)

# dated provenance comment right above the entry
new_u=data.get('selectedBy',{}).get('pickedUtility',data['metrics'].get('objective'))
marker=f"# tuned {data['at'][:19]} by dsh-memory-tune: utility {new_u} vs {data['live']['metrics']['utility']}, precision {data['metrics']['precision']} vs {data['live']['metrics']['precision']}, negHit {data['metrics']['negativeHitRate']} vs {data['live']['metrics']['negRate']}"
if start>0 and lines[start-1].startswith("# tuned "):
    lines[start-1]=marker
else:
    lines.insert(start,marker); start+=1; end+=1

lines[start:end]=block
open(path,"w",encoding="utf-8").write("\n".join(lines))
print("patched:", ", ".join(applied))
PY
then
  log "patch rewrite failed — restoring backup"
  cp -a "$BAK" "$PATCH"
  exit 1
fi

# The patch layer carries !!js custom tags: validate with a loader that accepts
# unknown tags and assert the memory-hub entry still parses as a mapping.
if ! python3 - "$PATCH" >>"$LOG" 2>&1 <<'PYEOF'
import sys, yaml
class Loader(yaml.SafeLoader): pass
Loader.add_multi_constructor("", lambda loader, suffix, node: None)
doc = yaml.load(open(sys.argv[1], encoding="utf-8"), Loader=Loader)
assert isinstance(doc, list), "patch layer must be a YAML list"
entry = [e for e in doc if isinstance(e, dict) and e.get("id") == "memory-hub"]
assert entry, "memory-hub entry missing"
cfg = entry[0].get("config")
assert isinstance(cfg, dict), "memory-hub config missing"
print("yaml ok:", ", ".join(f"{k}={v}" for k, v in sorted(cfg.items())))
PYEOF
then
  log "patch is not valid YAML — restoring backup"
  cp -a "$BAK" "$PATCH"
  tg "memory-hub tune $DAY: правка патча дала невалидный YAML, откатил."
  exit 1
fi

chown ka:ka "$PATCH" "$BAK" 2>/dev/null

# ── apply + verify ──────────────────────────────────────────────────────────
APPLIED=1
if [ "$NORESTART" -eq 1 ]; then
  log "--no-restart: patch written, profile not restarted (takes effect on next start)"
else
  RC=0
  restart_profile || RC=$?
  if [ "$RC" -eq 2 ]; then
    log "PATCH WRITTEN BUT NOT APPLIED: restart needs root. The running profile keeps the old settings until the next start."
    APPLIED=0
    NOK=1
  elif [ "$RC" -eq 1 ]; then
    log "profile did not come up after the patch — rolling back"
    cp -a "$BAK" "$PATCH"; chown ka:ka "$PATCH" 2>/dev/null
    if restart_profile; then
      log "rollback ok, profile is healthy on the previous settings"
      tg "memory-hub tune $DAY: новые настройки уронили профиль, откатился на прежние. Служба поднята."
      APPLIED=0
    else
      log "rollback restart also failed — manual attention required"
      tg "memory-hub tune $DAY: профиль не поднимается даже после откката. Нужен ручной разбор."
      exit 1
    fi
  else
    log "profile healthy on the new settings (pid changed, API answers)"
  fi
fi

# ── record ──────────────────────────────────────────────────────────────────
python3 - "$OUT" "$HIST" "${SNAP:-}" "$APPLIED" "$DRY" <<'PY' 2>/dev/null
import json,sys,time
out,hist,snap,applied,dry=sys.argv[1],sys.argv[2],sys.argv[3],sys.argv[4],sys.argv[5]
d=json.load(open(out))
rec={"at":d["at"],"epoch":int(time.time()),"applied":applied=="1","reason":"applied" if applied=="1" else "rolled back",
     "improvement":d.get("improvement"),"live":d.get("live",{}).get("metrics"),"chosen":d.get("chosen"),
     "metrics":d.get("metrics"),"sample":d.get("sample"),"bands":d.get("bands"),"snapshot":snap,"dry_run":dry=="1"}
open(hist,"a").write(json.dumps(rec,ensure_ascii=False)+"\n")
PY

node -e "
const {DatabaseSync}=require('node:sqlite');
const d=new DatabaseSync(process.argv[1]);
const now=String(Date.now());
const put=d.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
put.run('lastTuneAt',now);
put.run('lastTuneUtility',process.argv[2]);
d.close();
" "$DB" "$NEW_UTIL" 2>>"$LOG" && log "meta lastTuneAt written"

# ── report ──────────────────────────────────────────────────────────────────
SUMMARY=$(python3 - "$OUT" "$APPLIED" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); applied=sys.argv[2]=="1"
c=d["chosen"]; m=d["metrics"]; l=d["live"]["metrics"]; s=d["sample"]
head="memory-hub tune (%s): %s" % (d["at"][:16].replace("T"," "), "применено" if applied else "запись без применения")
lines=[head,
 f"точность {m['precision']:.2f} ↔ {l['precision']:.2f}, попадание {m['recall']:.2f} ↔ {l['recall']:.2f}",
 f"ложные срабатывания {m['negativeHitRate']:.2f} ↔ {l['negRate']:.2f}, блок {m['avgBlockChars']} ↔ {l['avgChars']} симв",
 f"порог {c['minRecallScore']} (было {d['live']['config']['minRecallScore']}), limit {c['recallLimit']} (было {d['live']['config']['recallLimit']}), бюджет {c['recallChars']} (было {d['live']['config']['recallChars']})",
 f"рутины {c['routineMinScore']}, навыки {c['skillMinScore']}, дрейф {c['goalDriftMin']}, guard {c['goalGuardChars']}",
 f"выборка: {s['kinshipQueries']} повторов, {s['negatives']} негативов, {s['chunks']} чанков"]
sys.stdout.write("\n".join(lines))
PY
)
log "--- report ---"
printf '%s\n' "$SUMMARY" | tee -a "$LOG"
tg "$SUMMARY"
exit 0
