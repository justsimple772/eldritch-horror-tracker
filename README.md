# 엘드리치 호러 트래커

Cloudflare Pages가 이 저장소를 배포합니다.

방 동기화 회귀 검증: Playwright와 Chromium이 설치된 환경에서
`node tests/room-sync.cjs`를 실행합니다. 시스템 Chromium을 사용할 때는
`CHROMIUM_PATH=/usr/bin/chromium node tests/room-sync.cjs`로 실행합니다.
실제 방에 접속하지 않고 저장소의 중계 서버 코드를 브라우저 두 개에 연결해
현재 조사자 우선 배정, 입장 전 전송 방지, ACK 반복 방지, 주사위 결과와 기록 공유를 확인합니다.
