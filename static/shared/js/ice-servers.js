/**
 * Shared STUN/TURN for WebRTC (1:1, mesh group, StrangerDanger).
 * TURN host: relay VM public IP (app.green-valley.homes → same IP).
 */
(function (global) {
  const TURN_HOST = "52.230.105.30";
  const TURN_USER = "homies";
  const TURN_CREDENTIAL = "fGrPL8PE0XGq7SqJOIILzYrM8r6BmGPR";

  global.HOMIES_ICE_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    {
      urls: [
        `turn:${TURN_HOST}:3478?transport=udp`,
        `turn:${TURN_HOST}:3478?transport=tcp`,
      ],
      username: TURN_USER,
      credential: TURN_CREDENTIAL,
    },
  ];
})(typeof window !== "undefined" ? window : globalThis);
