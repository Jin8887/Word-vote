/*************************************************************
 *  핵심가치 선정 · 투표  ―  Google Apps Script 백엔드
 *  ---------------------------------------------------------
 *  ▷ 참여자 실시간 후보 제안 버전
 *  역할: 세션 생성 / 후보 제안·조회 / 후보 확정 / 투표 저장 / 집계
 *
 *  시트(자동 생성):
 *    - Sessions   : code / title / phase / candidates(확정후보 JSON) / createdAt
 *    - Suggestions: code / name / team / candidate / suggestedAt
 *    - Votes      : code / name / team / scores(JSON) / submittedAt
 *
 *  phase 값: 'suggest'(후보 제안중) -> 'vote'(투표중) -> 'closed'(마감)
 *
 *  [주의] 한국어 환경: 코드가 시트를 자동 생성하므로 "시트1" 그대로 두셔도 됩니다.
 *************************************************************/

var SHEET_SESSIONS    = 'Sessions';
var SHEET_SUGGESTIONS = 'Suggestions';
var SHEET_VOTES       = 'Votes';

/* ---------- 진입점 ---------- */
function doGet(e){
  return handle_(e, (e.parameter && e.parameter.action) || '', e.parameter || {});
}
function doPost(e){
  var body = {};
  try { body = JSON.parse(e.postData.contents); } catch(_) {}
  return handle_(e, body.action || '', body);
}

function handle_(e, action, p){
  try{
    var out;
    switch(action){
      case 'createSession':  out = createSession_(p);  break;
      case 'getSession':     out = getSession_(p);     break;
      case 'suggest':        out = suggest_(p);        break;
      case 'getSuggestions': out = getSuggestions_(p); break;
      case 'finalize':       out = finalize_(p);       break;
      case 'submitVote':     out = submitVote_(p);     break;
      case 'getResults':     out = getResults_(p);     break;
      default: throw new Error('알 수 없는 요청: ' + action);
    }
    return json_(merge_({ ok:true }, out));
  }catch(err){
    return json_({ ok:false, error: String(err && err.message || err) });
  }
}

/* ---------- 세션 생성 (후보 없이 빈 세션) ---------- */
function createSession_(p){
  var code = String(p.code||'').trim();
  if(!/^\d{4}$/.test(code)) throw new Error('세션 코드 형식 오류');

  var sh = sheet_(SHEET_SESSIONS, ['code','title','phase','candidates','createdAt']);
  removeRows_(sh, 0, code);
  removeRows_(sheet_(SHEET_SUGGESTIONS, ['code','name','team','candidate','suggestedAt']), 0, code);
  removeRows_(sheet_(SHEET_VOTES, ['code','name','team','scores','submittedAt']), 0, code);

  sh.appendRow([code, String(p.title||''), 'suggest', '[]', new Date()]);
  return { code: code, phase:'suggest' };
}

/* ---------- 세션 조회 (phase + 확정후보) ---------- */
function getSession_(p){
  var code = String(p.code||'').trim();
  var sh = sheet_(SHEET_SESSIONS, ['code','title','phase','candidates','createdAt']);
  var rows = sh.getDataRange().getValues();
  for(var i=rows.length-1; i>=1; i--){
    if(String(rows[i][0])===code){
      return {
        code: code, title: rows[i][1], phase: rows[i][2] || 'suggest',
        candidates: safeArr_(rows[i][3])
      };
    }
  }
  throw new Error('해당 코드의 세션을 찾을 수 없습니다');
}

/* ---------- 후보 제안 ---------- */
function suggest_(p){
  var code = String(p.code||'').trim();
  var name = String(p.name||'').trim();
  var cand = normalize_(p.candidate);
  if(!code || !cand) throw new Error('후보를 입력하세요');

  var ses = getSession_({code:code});
  if(ses.phase !== 'suggest') throw new Error('이미 후보 제안이 마감되었습니다');

  var sh = sheet_(SHEET_SUGGESTIONS, ['code','name','team','candidate','suggestedAt']);

  var rows = sh.getDataRange().getValues();
  for(var i=1;i<rows.length;i++){
    if(String(rows[i][0])===code && String(rows[i][1])===name
       && normalize_(rows[i][3])===cand){
      throw new Error('이미 제안한 후보입니다');
    }
  }
  sh.appendRow([code, name, String(p.team||''), String(p.candidate).trim(), new Date()]);
  return { saved:true };
}

/* ---------- 제안 목록 (중복 병합 + 집계) ---------- */
function getSuggestions_(p){
  var code = String(p.code||'').trim();
  var sh = sheet_(SHEET_SUGGESTIONS, ['code','name','team','candidate','suggestedAt']);
  var rows = sh.getDataRange().getValues();

  var map = {};
  for(var i=1;i<rows.length;i++){
    if(String(rows[i][0])!==code) continue;
    var label = String(rows[i][3]).trim();
    var key = normalize_(label);
    if(!key) continue;
    if(!map[key]) map[key] = { label: label, count:0, proposers:[] };
    map[key].count += 1;
    var nm = String(rows[i][1]).trim();
    if(nm && map[key].proposers.indexOf(nm)<0) map[key].proposers.push(nm);
  }
  var items = Object.keys(map).map(function(k){ return map[k]; });
  items.sort(function(a,b){ return (b.count-a.count) || a.label.localeCompare(b.label,'ko'); });
  return { code:code, suggestions: items };
}

/* ---------- 후보 확정 -> 투표 단계로 전환 ---------- */
function finalize_(p){
  var seen = {}, finalC = [];
  (p.candidates||[]).forEach(function(c){
    var k = normalize_(c);
    if(k && !seen[k]){ seen[k]=1; finalC.push(String(c).trim()); }
  });
  if(finalC.length < 2) throw new Error('확정 후보가 2개 이상 필요합니다');

  var code = String(p.code||'').trim();
  var sh = sheet_(SHEET_SESSIONS, ['code','title','phase','candidates','createdAt']);
  var rows = sh.getDataRange().getValues();
  for(var i=rows.length-1;i>=1;i--){
    if(String(rows[i][0])===code){
      sh.getRange(i+1, 3).setValue('vote');
      sh.getRange(i+1, 4).setValue(JSON.stringify(finalC));
      return { code:code, phase:'vote', candidates:finalC };
    }
  }
  throw new Error('세션을 찾을 수 없습니다');
}

/* ---------- 투표 저장 ---------- */
function submitVote_(p){
  var code = String(p.code||'').trim();
  var name = String(p.name||'').trim();
  if(!code || !name) throw new Error('필수 정보 누락');
  var sh = sheet_(SHEET_VOTES, ['code','name','team','scores','submittedAt']);
  sh.appendRow([code, name, String(p.team||''), JSON.stringify(p.scores||[]), new Date()]);
  return { saved:true };
}

/* ---------- 결과 집계 ---------- */
function getResults_(p){
  var code = String(p.code||'').trim();
  var cands = [];
  try { cands = getSession_({code:code}).candidates; } catch(_) {}

  var sh = sheet_(SHEET_VOTES, ['code','name','team','scores','submittedAt']);
  var rows = sh.getDataRange().getValues();

  var agg = {}, voters = [];
  cands.forEach(function(c){ agg[c] = {sum:0, count:0}; });

  for(var i=1;i<rows.length;i++){
    if(String(rows[i][0])!==code) continue;
    voters.push(String(rows[i][1]));
    var sc = safeArr_(rows[i][3]);
    sc.forEach(function(item){
      var nm=item.name, v=Number(item.score)||0;
      if(!agg[nm]) agg[nm]={sum:0,count:0};
      agg[nm].sum+=v; agg[nm].count+=1;
    });
  }
  var results = Object.keys(agg).map(function(nm){
    var a=agg[nm];
    return { name:nm, sum:a.sum, count:a.count, avg: a.count? a.sum/a.count : 0 };
  });
  return { code:code, results:results, voters:voters };
}

/* ---------- 유틸 ---------- */
function normalize_(s){
  return String(s==null?'':s).trim().replace(/\s+/g,' ').toLowerCase();
}
function safeArr_(s){ try{ var v=JSON.parse(s); return (Object.prototype.toString.call(v)==='[object Array]')?v:[]; }catch(_){ return []; } }
function merge_(a,b){ for(var k in b){ if(b.hasOwnProperty(k)) a[k]=b[k]; } return a; }
function sheet_(name, headers){
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if(!sh){ sh = ss.insertSheet(name); sh.appendRow(headers); sh.setFrozenRows(1); }
  return sh;
}
function removeRows_(sh, colIdx, value){
  var rows = sh.getDataRange().getValues();
  for(var i=rows.length-1;i>=1;i--){
    if(String(rows[i][colIdx])===String(value)) sh.deleteRow(i+1);
  }
}
function json_(obj){
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
