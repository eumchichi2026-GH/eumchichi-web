/* =====================================================================
   Soundiiz 임포트 링크 중계 (Vercel Serverless Function)

   추천 시퀀스를 사용자의 음악 서비스에 플레이리스트로 저장하기 위한 중계다.
   Soundiiz 공개 Import API 는 인증이 없지만 CORS 헤더를 주지 않아서
   브라우저에서 직접 부를 수 없다. 그래서 서버를 한 번 거친다.

   POST { destination, name, tracks:[{title, artists?}] }
        → { shareUrl, nbTracks, expiresAt }   (Soundiiz 응답·상태코드 그대로 전달)

   중요 — 표기 규칙(데이터팀 실측, 2026-09-10):
     플랫폼마다 자기 로케일 표기로만 곡을 찾는다. 같은 20곡 표본에서
       한글 표기 → YouTube Music 16/20 · Spotify  3/20
       영문 표기 → YouTube Music  2/20 · Spotify 19/20
     두 표기를 한 문자열에 병기하면 오히려 양쪽 다 떨어진다(11/20, 4/20).
     그래서 어느 표기를 보낼지는 프런트가 destination 을 보고 정한다.
     이 함수는 받은 문자열을 그대로 넘긴다.

   레이트리밋: Soundiiz 는 클라이언트 IP 당 분당 10회다. 이 함수를 거치면
   서비스 전체가 하나의 IP 를 공유하므로 429 가 날 수 있다. 상태코드를 그대로
   전달하니 프런트가 "목록 복사" 폴백을 안내한다.
   ===================================================================== */

const ENDPOINT = "https://soundiiz.com/go/import-playlist";

/* Soundiiz corename. 빈 문자열은 "대상을 고르지 않음" — 선택 화면으로 보낸다.
   YouTube Music 은 `ytmusic` 이다. `youtubemusic` 은 거부당한다(2026-09-10 확인). */
const DESTINATIONS = new Set(["", "ytmusic", "spotify"]);

const MAX_TRACKS = 200;     // Soundiiz 상한
const MAX_ARTISTS = 3;      // 그 이상은 매칭에 도움이 안 되고 페이로드만 키운다

const clean = (s, max) => String(s == null ? "" : s).trim().slice(0, max);

export default function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  const { destination = "", name = "", tracks } = req.body || {};

  if (typeof destination !== "string" || !DESTINATIONS.has(destination)) {
    return res.status(400).json({ error: "invalid destination" });
  }
  if (!Array.isArray(tracks) || tracks.length === 0) {
    return res.status(400).json({ error: "empty tracklist" });
  }

  const tracklist = [];
  for (const t of tracks.slice(0, MAX_TRACKS)) {
    const title = clean(t && t.title, 200);
    if (!title) continue;                       // 제목 없는 항목은 Soundiiz 가 거부한다
    const artists = (Array.isArray(t && t.artists) ? t.artists : [])
      .map(a => clean(a, 120))
      .filter(Boolean)
      .slice(0, MAX_ARTISTS);
    tracklist.push(artists.length ? { title, artists } : { title });
  }
  if (!tracklist.length) {
    return res.status(400).json({ error: "no usable track" });
  }

  const payload = {
    title: clean(name, 120) || "AZT 오늘의 음악",
    sourceName: "AZT",
    tracklist
  };
  if (destination) payload.destination = destination;

  return fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  })
    .then(async r => {
      const data = await r.json().catch(() => ({}));
      return res.status(r.status).json(data);
    })
    .catch(() => res.status(502).json({ error: "soundiiz unreachable" }));
}
