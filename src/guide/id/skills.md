---
title: Skill
summary: Paket instruksi yang bisa dipakai ulang, kapan diaktifkan, dan kontrol per chat.
order: 6
---

# Skill

Skill adalah blok instruksi bernama yang disuntikkan ke system prompt: aturan kontinuitas, protokol kritik, panduan genre. Skill bersifat global; setiap chat bisa membisukannya.

## Bawaan
Sembilan skill ikut terpasang: continuity, prose, dialogue, pacing, beta reader, architect, voice, hook, dan line editor. Semuanya bertanda **Builtin**:
- teksnya bisa kamu ubah,
- **Reset** mengembalikan versi bawaan,
- tidak bisa dihapus.

## Menambah skill
[[settings:skills]] → **Tambah skill** membuka editor dengan nama, deskripsi, isi, dan pratinjau blok yang disuntikkan. **Simpan** membuatnya **nonaktif** — tidak ada yang sampai ke model sampai kamu menekan **Aktifkan**, jadi skill setengah jadi tidak pernah menyentuh balasan.

Mulai dari templat (Kosong, Line editor, Beta reader, Worldbuilding) atau impor file `.md`. Ekspor menghasilkan file markdown portabel.

## Kontrol per chat
Composer menampilkan chip `Skill n` saat ada skill aktif. Popover-nya menaruh skill untuk desk **Chat** atau **Agent** di atas, lalu melipat desk lain ke *Desk lain* — skill yang sudah aktif dari desk lain tetap muncul di sana, jadi filter tidak pernah menyembunyikannya. Mematikan satu menyimpan id-nya di daftar pengecualian chat tersebut.

Workspace **Menulis** tidak punya baris chat, jadi editor AI-nya memakai skill kategori Menulis yang aktif secara global; header editor menampilkan jumlahnya.

## Skill Lab
Buka skill di [[settings:skills]] untuk melihat **Skill Lab**:
- blok persis yang ditambahkan ke system prompt,
- perkiraan karakter dan token,
- pemakaian anggaran 12.000 karakter dari set aktif,
- peringatan bila skill aktif lain punya instruksi duplikat, fokus yang sama, atau arah yang berbeda (pendek vs panjang, tulis ulang vs pertahankan, bertanya vs jangan bertanya, formal vs santai),
- **Pakai di chat ini** untuk mengaktifkannya tanpa keluar dari Pengaturan.

Hitungan token memakai perkiraan 4 karakter per token, bukan tokenizer provider, tapi konsisten dengan penghitung di composer.

## Agent memilih skill sendiri
Di mode Agent, model bisa menyalakan dan mematikan skill sendiri, per chat. Sebelum mengerjakan sesuatu ia memanggil `list_skills`, lalu `use_skill` untuk paket yang cocok — continuity sebelum memeriksa kanon, prose saat menulis, beta reader saat mengkritik — dan `drop_skill` saat sudah tidak berlaku. Setiap perubahan muncul di log tool dan sebagai toast, chip di composer ikut berubah, jadi tidak ada perubahan otomatis yang diam-diam. Karena pilihannya disimpan di chat, skill tetap aktif untuk giliran berikutnya.

## Ukuran prompt
Blok skill dibatasi 12.000 karakter. Skill yang tidak muat diganti `[skill truncated: …]` alih-alih dipotong di tengah instruksi.

## Kapan skill merugikan
Tiga skill yang bertumpang tindih sering saling bertentangan. Aktifkan dua atau tiga per proyek dan biarkan agent.md membawa aturan umum.
