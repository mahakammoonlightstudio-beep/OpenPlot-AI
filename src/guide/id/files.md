---
title: File di chat
summary: Lampirkan file, batasannya, dan bagaimana isinya sampai ke model.
order: 3
---

# File di chat

Ikon paperclip di composer melampirkan file ke **pesan berikutnya** saja. Lampiran tampil sebagai kartu di atas input — tidak ditempel ke kotak teks, jadi tidak ada yang terkirim dua kali.

## Batasan
| Batasan | Nilai |
| --- | --- |
| File per pesan | 8 |
| Per file | 256 KB |
| Total per pesan | 1 MB |

Batasan dicek sebelum pesan ditulis: file kebesaran atau biner ditolak dengan satu pesan yang jelas dan composer tetap utuh.

## Yang bisa dilampirkan
- File teks: `.md`, `.txt`, `.json`, `.csv`, kode sumber, `.srt`.
- Entri story dan bab dari proyek aktif.

File biner (gambar, PDF, `.docx`) tidak diurai; ekspor teksnya dulu.

## Sampai ke model
Isi lampiran ditambahkan ke system prompt di bagian *Attached files*, lengkap dengan nama, jenis, dan ukuran. File panjang dipotong dan model diberi tahu.

File disimpan bersama pesan, jadi membuka chat lagi tetap menampilkan kartunya. Menghapus pesan atau chat menghapus filenya.
