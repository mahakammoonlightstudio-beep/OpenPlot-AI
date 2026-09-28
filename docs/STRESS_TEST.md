# OpenPlot AI — Extreme Stress Test

Hasil pengujian ketahanan engine AI (`electron/ai.ts`) terhadap kondisi hostil yang bisa
dihasilkan relay/provider nyata: balasan rusak, koneksi mati mendadak, payload raksasa,
dan beban tinggi.

Jalankan dengan:

```bash
node scripts/stress-test.mjs
```

Target suite: **14 check, semua PASS** (per 2026-09-24).

## Skenario

| # | Skenario | Mock | Yang diuji |
|---|----------|------|------------|
| S1 | Malformed SSE | `malformed` — baris sampah, JSON pecah, tanpa urutan wajar | Parser tidak crash; delta valid tetap diselamatkan (`survivor`) |
| S2 | Socket dipotong di tengah reply | `midcut` — `res.destroy()` setelah 1 delta | Promise settle (error ATAU teks parsial), tidak pernah nyangkut |
| S3 | Stall lalu mati | `stall` — SSE terbuka, hanya comment ping, lalu destroy | Resolve sebagai error jauh di bawah timeout 30s |
| S4 | Halaman HTML di endpoint chat | `html` — semua path menyajikan landing page | HTTP 200 berupa HTML ditolak dengan pesan yang bisa dibaca manusia |
| S5 | 20 generasi konkuren | `good` | Semua hasil utuh & identik, tidak ada state bleed antar call |
| S6 | Abort storm (10 sekaligus) | `good` | Semua promise settle, tanpa deadlock |
| S7 | Payload ~400KB | `slow_big` — 12000 token, burst tiap 8ms | Reply sampai utuh ke ujung; chunk streaming terhitung |
| S8 | Rapid-fire 30x sekuensial | `good` | 30/30 hasil konsisten; tidak ada kebocoran keep-alive/socket |
| S9 | verifyModel/validateKey vs mode hostil | `html` → `good` | HTML dilaporkan anggun; pemulihan normal di endpoint sehat |

## Bug yang ditemukan & diperbaiki selama stress test

1. **Streaming nyangkut (hang) — bug paling kritis.** Saat stream gagal di tengah jalan
   (S2/S3), UI tidak pernah kembali bisa dipakai. Fix: `try/finally` di `ChatView.send()`
   + `abort()` melepas UI segera.
2. **Keep-alive poisoning.** Socket dari respons hostil "menulari" koneksi reuse ke
   request berikutnya. Fix: `tryHttpRequest()` pakai `agent: false`-style clean socket per
   kandidat base URL, dan mock test memaksa `Connection: close`.
3. **HTML berstatus 200 dianggap sukses.** Relay yang menyajikan landing page dengan kode
   200 dulu dianggap balasan valid. Fix: `isHtmlBody()` dijalankan pada body apa pun
   berstatus sukses sebelum di-parse.
4. **`verifyModel` hanya mengenali satu shape balasan.** Relay non-standar
   (`{content:[...]}`, `{response}`, `{output_text}`) dilaporkan gagal padahal model
   sehat. Fix: ekstraksi multi-shape.
5. **`providers.kind` hilang saat restart.** Kolom tidak ikut disimpan oleh
   `updateProvider`, sehingga deteksi gaya Anthropic/OpenAI kacau setelah reboot. Fix:
   migrasi kolom + simpan di create/update (dibuktikan oleh S9 yang mengandalkan `kind`).
6. **Kandidat Base URL kaku.** Salah satu format umum (endpoint penuh, tanpa `/v1`,
   dengan `/v1/extra`) bikin request 404. Fix: `baseUrlCandidates()` mencoba beberapa
   varian secara berurutan.

## Batasan yang diketahui (by design)

- **Timeout 30s hard** per request HTTP (`tryHttpRequest`). Model reasoning yang lambat
  bisa kena; saat ini tidak dikonfigurasi per-provider.
- **Health status bar bersifat lokal.** Data di `openplot.modelHealth.v1` (maks 40 event
  per model, ambang degraded 6 detik) adalah pengamatan klien, bukan uptime resmi
  provider.
- **Render window 60 pesan.** Chat sangat panjang merender bertahap (skeleton +
  tombol "Load N earlier"); memory hemat, tapi scroll ke pesan tertua butuh beberapa klik.
- **Abort path engine diuji terpisah** di `scripts/engine-test.mjs` (penghentian
  mid-stream); S6 hanya memastikan storm abort tidak deadlock.
- **Mock memakai protokol OpenAI penuh**; variasi kuasi-OpenAI nyata (mis. SSE dengan
  `usage` aneh, SSE kosong tanpa `[DONE]` di akhir) tercakup sebagian oleh S1.

## Cakupan test lain

- `node scripts/engine-test.mjs` — streaming inkremental, tool-call, abort mid-stream.
- `node scripts/url-fix-test.mjs` — matriks kandidat Base URL & ekstraksi error.
