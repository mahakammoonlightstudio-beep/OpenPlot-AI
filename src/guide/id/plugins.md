---
title: Plugin
summary: Ekstensi JS lokal, hook-nya, dan batasannya.
order: 14
---

# Plugin

Plugin adalah file JavaScript lokal dengan hook. Plugin berjalan di proses utama dengan akses yang sama seperti aplikasi: pasang hanya kode yang kamu tulis atau baca.

## Bentuk
```js
module.exports = {
  name: 'word-count-logger',
  hooks: {
    'message:new': (payload, api) => api.log('message ' + payload.role)
  }
}
```

## Hook
Yang dijalankan aplikasi saat ini: `chat:new` (baris chat dibuat) dan `message:new` (pesan disimpan).

`app:ready`, `chat:send`, `chapter:saved`, `project:created`, dan `skill:enabled` ada di API plugin tetapi belum disambungkan — anggap rencana, dan jalankan nama hook-mu sendiri bila perlu sekarang.

## Perilaku
- Plugin nonaktif tidak pernah dimuat, bukan dimuat lalu diblokir.
- Error ditangkap per hook dan ditulis ke log plugin; plugin rusak tidak merusak chat.
- Plugin mendaftarkan perintah dengan `context.registerCommand`; daftar baris di Pengaturan → Plugin menampilkan log-nya.

Lihat `docs/PLUGIN_API.md` di repositori untuk permukaan lengkapnya.
