---
title: Pengaturan
summary: Mode sederhana vs lanjutan, pencarian, dan lokasi tiap kontrol.
order: 13
---

# Pengaturan

Pengaturan dikelompokkan berdasarkan tujuanmu, bukan model data:

- **AI** — provider, model, perilaku.
- **Chat** — gaya, skill, agent.md.
- **Tampilan** — tema (ikut sistem secara bawaan), aksen, ukuran font, bahasa.
- **Data** — library, snapshot Time Machine, memori, penggunaan, backup, dan reset.
- **Ekstensi** — plugin, automasi, MCP *(mode lanjutan)*.
- **Tentang** — versi, lokasi data, vault kredensial, panduan.

## Pencarian
Kotak pencarian di atas nav menemukan kontrol, bukan hanya bagian: ketik `cache` untuk mendarat di baris cache pada halaman model. `↑`/`↓` berpindah, `Enter` melompat dan memfokuskan kontrol, `Esc` membersihkan.

## Bahasa
Tampilan → Bahasa mengganti antarmuka antara English (US), English (UK), Bahasa Indonesia, Español, dan हिन्दी. English (UK) memakai ejaan Britania; Spanyol dan Hindi masih beta, jadi layar intinya sudah diterjemahkan sementara pengaturan lanjutan jatuh ke bahasa Inggris dan memberi tahu.

## Sederhana vs lanjutan
Mode sederhana menyembunyikan parameter model lanjutan dan grup Ekstensi. Tidak ada yang dihapus — *Tampilkan pengaturan lanjutan*, juga di palette, mengembalikan semuanya, dan pilihannya diingat.

## Time Machine
[[settings:data]] menyimpan maksimal 12 snapshot utuh per library. Snapshot dibuat sebelum upgrade skema, impor, reset, atau restore, ditambah salinan harian dan *Snapshot sekarang*. Saat memulihkan, aplikasi bertanya dulu, menyimpan kondisi sekarang sebagai snapshot lain, lalu restart ke salinan yang dipilih. Snapshot terpisah per library, jadi memulihkan satu library tidak menyentuh library lain.

## Reset
Setiap bagian bisa mereset bawaannya sendiri. *Reset semua data* di [[settings:data]] menghapus segalanya; snapshot *Sebelum reset* dibuat otomatis, tapi ekspor dulu kalau datanya penting.
