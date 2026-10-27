---
title: Pemecahan masalah
summary: Kegagalan yang benar-benar akan kamu temui dan solusi tercepatnya.
order: 18
---

# Pemecahan masalah

## "No model selected"
Chat belum punya model dan Auto tidak bisa menentukan. Pilih bawaan di [[settings:models]], atau pilih model di composer.

## 401 / 403 dari provider
Key salah, kedaluwarsa, atau tidak punya akses ke model itu. Tempel ulang, lalu **Verify** modelnya.

## 404 atau "model not found"
Nama model tidak ada untuk provider itu, atau base URL kehilangan `/v1`. Pakai *Test & fetch* untuk melihat daftar sebenarnya.

## Balasan kosong saat tools aktif
Sebagian model mengirim tool call tanpa teks. Aplikasi mencoba sekali lagi; bila berulang, matikan tools untuk chat itu atau ganti ke model yang andal memakai tools.

## Rate limit
Tunggu, atau ganti provider. Teks error dari provider ditampilkan apa adanya agar kamu bisa melihat waktu reset.

## Aplikasi terasa lambat
Chat panjang memuat 80 pesan terbaru lebih dulu. Bila mengetik terasa berat, tutup popover model dan pastikan chat tidak membawa puluhan lampiran.

## Masalah database
Migrasi yang gagal membiarkan file utuh dan melaporkan errornya. Kembalikan salinan `.bak` di sebelah database, atau ekspor dari mesin lain.

Masih macet? Issue tracker repositori adalah jalur tercepat: sertakan versi dari [[settings:about]] dan teks error persisnya.
