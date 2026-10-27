---
title: Server MCP
summary: Apa yang dilakukan definisi server hari ini, dan apa yang menyusul.
order: 15
---

# Server MCP

MCP (Model Context Protocol) adalah cara model memanggil tools di luar aplikasi: helper filesystem, indeks pencarian, database.

## Status di versi ini

[[settings:mcp]] menyimpan definisi server secara lokal — nama, perintah, argumen, variabel lingkungan, dan tanda aktif. **Bridge yang menjalankan prosesnya, mendaftar tool-nya, dan mengeksposnya ke model belum ada di versi ini.** Definisi yang tersimpan tidak pernah menjalankan apa pun; mengaktifkannya adalah persiapan untuk rilis yang membawa bridge-nya.

Rencananya dan detail protokolnya ada di `docs/PLUGIN_API.md` dan rencana rilis di `docs/superpowers/plans/`.

## Yang bisa dilakukan sekarang

- Siapkan registry: tambahkan server yang kamu inginkan, dengan perintah dan argumen yang persis, agar nanti cukup satu saklar.
- Baca perintahnya sebelum menyimpan. Server MCP berjalan sebagai proses lokal dengan izinmu; perlakukan definisinya seperti skrip yang akan kamu jalankan.

## Yang akan dilakukan bridge-nya

- Menjalankan hanya server yang aktif, setelah jendela siap, dan mematikannya saat keluar.
- Berbicara JSON-RPC 2.0 newline-delimited lewat stdio: `initialize`, `tools/list`, `tools/call`.
- Menampilkan tool-nya sebagai `mcp__{server}__{tool}` saat tools aktif, dengan timeout panggilan dan batas ukuran hasil.
- Menampilkan titik status per server (starting, connected, error), jumlah tool, error terakhir, dan log yang bisa difilter.

Sementara itu, tools cerita milik aplikasi adalah yang benar-benar bisa dipanggil model — lihat artikel skill dan story bible.
