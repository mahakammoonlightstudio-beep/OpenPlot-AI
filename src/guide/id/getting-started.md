---
title: Memulai
summary: Pasang, tambah satu API key, kirim pesan pertama.
order: 1
---

# Memulai

OpenPlot AI adalah studio chat dan cerita yang lokal-first. Chat, proyek, story bible, dan pengaturanmu tersimpan dalam satu file SQLite di mesinmu — hanya permintaan ke model yang keluar dari aplikasi.

## 1. Tambah provider
Buka [[settings:providers]] lalu pakai **Smart setup** (pilih preset → tempel key → tes) atau tambah provider manual.

Setiap baris provider butuh:
- **Base URL** — akar API, misalnya `https://api.openai.com/v1`.
- **API key** — terenkripsi saat vault OS tersedia.
- **Model** — ambil dengan *Test & fetch*, atau tulis manual.

## 2. Pilih model
Pengaturan → [[settings:models]] menampilkan setiap model dengan chip kemampuannya. Pilih satu sebagai bawaan, atau biarkan **Auto (disarankan)**.

## 3. Mulai chat
`Ctrl+N` membuat chat. Ketik, `Enter` untuk kirim, `Shift+Enter` untuk baris baru. `Ctrl+K` membuka command palette dari mana saja.

## 4. Beri proyek (opsional)
Proyek menyimpan story bible, bab, dan blok konteks. Sambungkan proyek ke chat dan model melihat kanonmu alih-alih menebak.

> Lanjutkan dengan artikel chat, file, skill, dan story bible, dalam urutan itu.
