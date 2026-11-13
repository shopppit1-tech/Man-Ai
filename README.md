# Man-Ai — Chat Gemini

Situs chat tanpa login yang didukung Google Gemini API. Frontend disajikan oleh backend Node.js kecil yang menjaga kunci Gemini tetap di server, tidak di halaman publik atau Git.

Ini adalah chat mandiri berbasis Gemini, bukan layanan resmi Manus. Situs dapat membuat jawaban, draf, dan rencana. Situs tidak menjalankan tugas eksternal atau menyediakan alat Manus seperti pembuatan slide, situs, atau video sungguhan.

## Jalankan secara lokal

Persyaratan: Node.js 20 atau yang lebih baru dan kunci Gemini API dari [Google AI Studio](https://aistudio.google.com/apikey).

1. Salin `.env.example` menjadi `.env`, lalu isi `GEMINI_API_KEY` dengan kunci utama. Secara opsional, isi `GEMINI_API_KEY_BACKUP` dan `GEMINI_API_KEY_BACKUP_2` sebagai kunci cadangan. Jangan commit file `.env`.
2. Jalankan server dengan `npm start`.
3. Buka `http://localhost:3000`.

Server juga menerima `GOOGLE_API_KEY` sebagai nama alternatif untuk kunci utama. Jika suatu kunci ditolak atau kuotanya habis, server akan mencoba kunci cadangan yang telah diatur secara berurutan. `GEMINI_MODEL` dapat digunakan untuk mengganti model bawaan (`gemini-4-hydrogen`).

## Deploy

Deploy repo ini sebagai layanan web Node.js, bukan hanya hosting statis GitHub Pages. Atur perintah start ke `npm start`, lalu masukkan `GEMINI_API_KEY` dan, jika diperlukan, `GEMINI_API_KEY_BACKUP` serta `GEMINI_API_KEY_BACKUP_2` pada pengaturan secret/environment variable di layanan hosting. Aplikasi menggunakan `PORT` yang diberikan oleh host. Jangan pernah memasukkan kunci API ke `index.html`, `script.js`, file `.env` publik, atau commit GitHub.

## Penggunaan tanpa login dan batas pemakaian

Pengunjung dapat memakai chat tanpa login. Server membatasi panjang prompt hingga 8.000 karakter, maksimal 12 pesan per menit untuk tiap IP, serta 200 pesan per hari secara global sebagai nilai bawaan. Atur `GEMINI_DAILY_LIMIT` untuk mengubah batas harian. Batas dalam memori ini akan direset saat layanan dimulai ulang dan hanya merupakan perlindungan sederhana; untuk penggunaan produksi, tambahkan pembatas pemakaian bersama yang persisten, pemantauan penggunaan, dan batas pengeluaran pada proyek Google API. Penggunaan Gemini tetap mengikuti ketersediaan model, kuota, dan pengaturan tagihan akun.

Browser menyimpan ID interaksi Gemini yang sedang berlangsung hanya di memori untuk pertanyaan lanjutan. Situs tidak memakai akun pengguna atau menyimpan riwayat chat di database.
