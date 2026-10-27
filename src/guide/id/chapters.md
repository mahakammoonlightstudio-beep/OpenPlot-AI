---
title: Bab
summary: Menulis draf, status, jumlah kata, dan riwayat versi.
order: 9
---

# Bab

Bab menyimpan naskah sesungguhnya. Setiap bab punya judul, isi, status (`draft`, `revising`, `done`), posisi, dan jumlah kata.

## Menulis di aplikasi
Editor menyimpan saat kamu menekan **Simpan** — tidak ada penulisan diam-diam di tengah kalimat. Riwayat versi menyimpan snapshot tiap simpan sehingga kamu bisa membandingkan atau kembali.

## Dengan model
Minta satu adegan dan model bisa `create_chapter`, `update_chapter`, `append_to_chapter`, dan `read_chapter`. Menambahkan lebih aman daripada menulis ulang: tulisanmu tidak tersentuh.

Agen menulis ke bab, bukan ke chat, saat keluarannya panjang. Prosa tetap di luar transkrip dan riwayat prompt.

## Status dan alur
Status bab mengisi [[route:flow]], yang mengubah beat jadi bab. Jumlah kata mengisi [[route:stats]].
