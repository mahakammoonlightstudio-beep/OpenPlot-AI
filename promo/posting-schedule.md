# Jadwal posting 7 hari

Jadwal pelaksanaan dari urutan di README folder ini. Hari 1 adalah hari pertama
eksekusi — isi kolom tanggal saat mulai. Asumsi zona waktu WIB.

Aturan yang tetap berlaku:

- EN dan ID untuk platform yang sama **tidak boleh** di hari yang sama.
- Satu variasi hook A/B per post uji, jarak 2–3 hari (lihat `hook-variations.md`).
- Perbandingan A/B hanya adil antar format yang sama: thread dibandingkan dengan
  thread, single tweet dengan single tweet. Karena itu hook A diuji dua kali —
  sebagai thread (Hari 1) dan sebagai single tweet (Hari 3) — supaya single
  tweet B/C/D/E punya baseline yang setara.
- Reddit: akun harus punya riwayat komentar di sub target sebelum posting proyek.
- Semua metrik dicatat di tabel `hook-variations.md` dan ringkasan mingguan di
  bawah.

## Tabel jadwal

| Hari | Tanggal | Jam (WIB) | Platform | Konten | Catatan |
| --- | --- | --- | --- | --- | --- |
| 1 | ___ | 09.00–11.00 | X | Thread EN — hook A (baseline thread) | Lampiran `01-chat.png` + `11-theme-light-paper.png`; link hanya di tweet 7 |
| 1 | ___ | 19.00–21.00 | YouTube Community | Post EN (versi utama) | Gambar `01-chat.png` |
| 2 | ___ | 08.00–10.00 | LinkedIn | Post EN | Link di komentar pertama milik sendiri |
| 2 | ___ | 19.00–21.00 | Reddit | r/SideProject EN | Jawab semua komentar dalam 24 jam |
| 3 | ___ | 09.00–11.00 | X | Single tweet EN — hook A (baseline single) | Titik pembanding A/B; catat metrik hari ini |
| 3 | ___ | kapan saja | Semua | Hari engagement: balas semua komentar, quote-tweet tanggapan | Tidak ada konten baru |
| 4 | ___ | 19.00–21.00 | X | Thread ID — hook A versi ID | Prime time malam untuk audiens Indonesia |
| 5 | ___ | 08.00–10.00 | LinkedIn | Post ID | Link di komentar pertama |
| 5 | ___ | 19.00–21.00 | YouTube Community | Post ID | Gambar `01-chat.png` atau tema terang |
| 6 | ___ | 09.00–11.00 | X | Single tweet EN — hook B (uji A/B #1) | Jarak ≥48 jam dari single sebelumnya |
| 6 | ___ | 15.00–18.00 | Reddit | r/LocalLLaMA EN (versi teknis) | Tonjolkan Ollama/LM Studio dan local-first |
| 7 | ___ | 08.00–10.00 | Reddit | Post ID (Kaskus / grup FB dev / komunitas menulis ID) | Ikuti aturan masing-masing tempat |
| 7 | ___ | malam | — | Review minggu 1: isi tabel `hook-variations.md`, hitung total metrik, susun rencana minggu 2 | Lanjut hook C/D/E, siapkan r/writing |

## Metrik yang dikumpulkan

| Platform | Sumber | Metrik |
| --- | --- | --- |
| X | Analytics per tweet | impressions, profile clicks, link clicks |
| LinkedIn | Analytics post | impressions, reaksi, komentar, klik link komentar |
| YouTube | Studio → Community | likes, komentar |
| Reddit | Post + repo Insights | upvote ratio, komentar; GitHub → Insights → Traffic untuk views/clone |
| GitHub | Insights → Traffic | views, unique visitors, clones — cek lonjakan setelah tiap gelombang post |

## Rencana minggu 2 (pratinjau)

1. Lanjutkan A/B: hook C, D, E sebagai single tweet EN dengan jarak 2–3 hari;
   hook juara lalu diuji ulang untuk audiens ID.
2. r/writing (versi feedback-first) setelah akun punya karma cukup di sub itu.
3. Quote-tweet thread terbaik saat milestone (mis. 100 stars, 500 downloads)
   dengan screenshot baru.
4. Pin tweet dengan hook juara di profil.

## Ringkasan minggu 1 (diisi di akhir pekan)

| Hari | Post | Impressions | Klik/Interaksi | Catatan |
| --- | --- | --- | --- | --- |
| 1 | X thread EN | | | |
| 1 | YouTube EN | | | |
| 2 | LinkedIn EN | | | |
| 2 | Reddit r/SideProject | | | |
| 3 | X single A | | | |
| 4 | X thread ID | | | |
| 5 | LinkedIn ID | | | |
| 5 | YouTube ID | | | |
| 6 | X single B | | | |
| 6 | Reddit r/LocalLLaMA | | | |
| 7 | Reddit ID | | | |
