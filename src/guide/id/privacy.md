---
title: Privasi dan data
summary: Apa yang tetap lokal, apa yang dikirim, dan di mana filenya.
order: 16
---

# Privasi dan data

## Lokal secara bawaan
Semua tersimpan di file SQLite pada folder data pengguna, terlihat di [[settings:data]]: chat, pesan, lampiran, proyek, story bible, bab, prompt, skill, pengaturan.

Tanpa analitik, tanpa telemetri, tanpa akun.

## Yang keluar dari mesin
Hanya permintaan yang kamu kirim: system prompt (bisa memuat agent.md, konteks proyek, skill, dan file terlampir), riwayat percakapan, dan pesanmu. Semuanya langsung ke provider yang kamu atur — tidak ada proxy di antaranya.

Gambar dan file dikirim sebagai teks. File biner ditolak, bukan diunggah.

## API key
Key terenkripsi saat vault kredensial OS tersedia; jika tidak, aplikasi mengatakannya di [[settings:data]]. Key tidak pernah masuk ke ekspor, log, atau pesan error.

## Menghapus
*Reset semua data* menghapus setiap baris dan isi file. Backup saat migrasi skema (`.bak`) tetap ada di sebelah database — hapus manual bila ingin bersih total.
