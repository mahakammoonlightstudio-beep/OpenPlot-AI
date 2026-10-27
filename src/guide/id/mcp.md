---
title: Server MCP
summary: Jalankan server MCP lokal dan biarkan model memanggil tool-nya.
order: 16
---

# Server MCP

MCP (Model Context Protocol) adalah cara model memanggil tools di luar aplikasi: helper filesystem, indeks pencarian, database.

## Yang sudah ada

[[settings:mcp]] menyimpan definisi server secara lokal — nama, perintah, argumen, variabel lingkungan, dan tanda aktif. Bridge hanya menjalankan server yang **aktif**, setelah jendela siap, berbicara JSON-RPC 2.0 newline-delimited lewat stdio (`initialize`, `tools/list`, `tools/call`), dan mematikan semua proses anak saat keluar.

- Tool ditampilkan sebagai `mcp__{server}__{tool}` dan hanya ditawarkan bila agent tools aktif di chat itu. Prompt memuat nama persis yang dilaporkan server, bukan tebakan.
- Satu panggilan tool diberi **30 detik**, start **10 detik**; satu baris respons dibatasi **1 MB**, dan teks yang sampai ke model dipotong di **20.000 karakter** dengan catatan pemotongan.
- Tiap server menampilkan status (starting, connected, error), jumlah tool, error terakhir, dan log yang bisa difilter (300 baris).

## Menambah server

1. Pengaturan → Server MCP → **Tambah**, atau pilih salah satu definisi yang direkomendasikan.
2. Isi perintah dan argumen persis seperti di terminal, misalnya `npx` dengan `["-y", "@modelcontextprotocol/server-filesystem", "D:\\Catatan"]`.
3. Variabel lingkungan berupa objek JSON: `{"API_KEY": "…"}`.
4. Aktifkan. **Restart** menjalankan ulang prosesnya; **Log** menunjukkan apa yang dicetaknya.

## Keamanan

Server MCP adalah perintah lokal sembarang yang berjalan dengan izinmu — tingkat kepercayaannya sama dengan plugin. Definisi tersimpan tidak pernah berjalan sendiri; mengaktifkannya adalah tindakan eksplisit, dan menonaktifkannya (atau keluar) menghentikan prosesnya. Baca perintahnya sebelum mengaktifkan, dan utamakan server yang kamu tulis atau audit sendiri. Pakai path absolut: prosesnya mulai di folder data aplikasi, bukan di folder proyekmu.

## Pemecahan masalah

- **Error saat start** — jalankan perintah yang sama di terminal dulu. Di Windows `npx`/`npm` otomatis dijalankan lewat `cmd.exe`; shell lain tidak.
- **Tidak ada tool** — server menjawab `initialize` tetapi tidak melaporkan tool. Log-nya memperlihatkan baris mentah yang dicetak.
- **Tool gagal** — pesan error dikembalikan ke model sebagai hasil tool, jadi model bisa bereaksi alih-alih menggantung.
