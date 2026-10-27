---
title: Skill
summary: Paket instruksi yang bisa dipakai ulang, kapan diaktifkan, dan kontrol per chat.
order: 6
---

# Skill

Skill adalah blok instruksi bernama yang disuntikkan ke system prompt: aturan kontinuitas, protokol kritik, panduan genre. Skill bersifat global; setiap chat bisa membisukannya.

## Bawaan
Enam skill ikut terpasang: continuity, prose, dialogue, pacing, beta reader, dan architect. Semuanya bertanda **Builtin**:
- teksnya bisa kamu ubah,
- **Reset** mengembalikan versi bawaan,
- tidak bisa dihapus.

## Menambah skill
[[settings:skills]] → **Tambah skill** membuka editor dengan nama, deskripsi, isi, dan pratinjau blok yang disuntikkan. **Simpan** membuatnya **nonaktif** — tidak ada yang sampai ke model sampai kamu menekan **Aktifkan**, jadi skill setengah jadi tidak pernah menyentuh balasan.

Mulai dari templat (Kosong, Line editor, Beta reader, Worldbuilding) atau impor file `.md`. Ekspor menghasilkan file markdown portabel.

## Kontrol per chat
Composer menampilkan chip `Skill n` saat ada skill aktif. Popover-nya mendaftar semua skill aktif dengan switch; mematikan satu menyimpan id-nya di daftar pengecualian chat tersebut.

## Ukuran prompt
Blok skill dibatasi 12.000 karakter. Skill yang tidak muat diganti `[skill truncated: …]` alih-alih dipotong di tengah instruksi.

## Kapan skill merugikan
Tiga skill yang bertumpang tindih sering saling bertentangan. Aktifkan dua atau tiga per proyek dan biarkan agent.md membawa aturan umum.
