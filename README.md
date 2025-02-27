# O'qituvchi va O'quvchilar uchun Test Bot

Bu Telegram bot o'qituvchilar va o'quvchilar uchun test tizimini boshqarish imkonini beradi.

## Asosiy xususiyatlari

### O'qituvchilar uchun
- Test yaratish
- Testlarni tahrirlash va o'chirish
- Dedlayn belgilash va o'zgartirish
- Test natijalarini Excel formatida yuklab olish
- Natijalarni ranglar bo'yicha ko'rish (80-100% - yashil, 60-80% - qora, 60% dan past - qizil)

### O'quvchilar uchun
- Testlarni topshirish
- O'z natijalarini ko'rish
- Reytingdagi o'rnini bilish

## O'rnatish

1. Repositoryni clone qiling
2. Kerakli paketlarni o'rnating:
   ```bash
   npm install
   ```

3. `.env.example` faylidan `.env` fayl yarating va sozlamalarni to'ldiring:
   - `BOT_TOKEN`: @BotFather dan olingan Telegram bot tokeni
   - `DATABASE_URL`: MongoDB ulanish URL'i
   - `REQUIRED_CHANNELS`: Majburiy obuna bo'lish kerak bo'lgan kanallar

4. Prisma sxemalarini generatsiya qiling:
   ```bash
   npx prisma generate
   ```

5. Ma'lumotlar bazasini yangilang:
   ```bash
   npx prisma db push
   ```

6. Botni ishga tushiring:
   ```bash
   npm start
   ```

## Ishlatish

1. O'qituvchilar uchun:
   - `/start` - botni ishga tushirish
   - "Test yaratish" - yangi test yaratish
   - "Testlarni boshqarish" - mavjud testlarni boshqarish
   - "Natijalarni ko'rish" - test natijalarini ko'rish va yuklab olish

2. O'quvchilar uchun:
   - `/start` - botni ishga tushirish va ro'yxatdan o'tish
   - "Mavjud testlar" - faol testlarni ko'rish va topshirish
   - "Mening natijalarim" - o'z natijalarini ko'rish
