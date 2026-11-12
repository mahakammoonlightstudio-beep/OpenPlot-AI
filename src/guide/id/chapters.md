---
title: Bab
summary: Menulis draf, status, jumlah kata, dan riwayat versi.
order: 9
---

# Bab

Bab menyimpan naskah sesungguhnya. Setiap bab punya judul, isi, status (`draft`, `revising`, `done`), posisi, dan jumlah kata.

## Menulis di aplikasi
Editor menyimpan saat kamu menekan **Simpan** — tidak ada penulisan diam-diam di tengah kalimat. Setiap simpan menyimpan snapshot teks sebelumnya.

**Riwayat** membuka Timeline Revisi bab: semua snapshot tersimpan dan setiap bagian teks yang tergeser oleh edit AI, terbaru dulu. Buka satu baris untuk melihat diff sebelum/sesudah dengan jumlah kata yang ditambah/dihapus, salin salah satu sisi, atau pulihkan. Saat memulihkan snapshot, teks yang sekarang disimpan dulu ke riwayat, jadi pemulihannya masih bisa dibatalkan. **Timeline** di atas halaman Bab menampilkan garis waktu yang sama untuk seluruh naskah, lengkap dengan saringan bab. Board Writing punya tombol yang sama di sebelah Simpan.

## Dengan model
Minta satu adegan dan model bisa `create_chapter`, `update_chapter`, `append_to_chapter`, dan `read_chapter`. Menambahkan lebih aman daripada menulis ulang: tulisanmu tidak tersentuh.

Setiap tulisan ulang AI atau simpan manual juga menyisakan prosa yang tergeser di **Text Dump**, di sidebar. Pratinjau atau salin, pulihkan ke posisi lamanya, atau hapus entri terpilih secara permanen. Pemulihan bertanya dulu sebelum menimpa teks yang lebih baru, dan agent bisa mencari tempat ini dengan `search_text_dump` saat kamu minta mengembalikan kalimat yang terpotong.

Agen menulis ke bab, bukan ke chat, saat keluarannya panjang. Prosa tetap di luar transkrip dan riwayat prompt.

## Status dan alur
Status bab mengisi [[route:flow]], yang mengubah beat jadi bab. Jumlah kata mengisi [[route:stats]].
