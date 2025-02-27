require('dotenv').config();
const { Telegraf, Scenes, session } = require('telegraf');
const { MongoClient, ObjectId } = require('mongodb');
const moment = require('moment');

// MongoDB connection
const client = new MongoClient(process.env.DATABASE_URL);
let db;

// Collections
let users;
let tests;
let testResults;

// Admin and Teacher IDs
const ADMIN_ID = parseInt(process.env.ADMIN_ID);
const TEACHER_IDS = (process.env.TEACHER_IDS || '').split(',').map(id => parseInt(id)).filter(Boolean);

// Initialize bot
const bot = new Telegraf(process.env.BOT_TOKEN);

// Enable session handling
bot.use(session());

// Error handling middleware
bot.catch((err, ctx) => {
  console.error(`Error while handling update ${ctx.update.update_id}:`, err);
  ctx.reply('❌ Xatolik yuz berdi. Iltimos qayta urinib ko\'ring.').catch(console.error);
});

// Check if user is teacher
const isTeacher = (userId) => {
  return TEACHER_IDS.includes(userId) || userId === ADMIN_ID;
};

// Middleware to check channel subscription
const checkSubscription = async (ctx, next) => {
  try {
    if (!ctx.from) return next();

    // Skip check for admin and teachers
    if (isTeacher(ctx.from.id)) {
      return next();
    }

    const channels = process.env.REQUIRED_CHANNELS.split(',');
    for (const channel of channels) {
      try {
        const member = await ctx.telegram.getChatMember(channel, ctx.from.id);
        if (!['creator', 'administrator', 'member'].includes(member.status)) {
          return ctx.reply(`❌ Botdan foydalanish uchun ${channel} kanaliga obuna bo'ling!`, {
            reply_markup: {
              inline_keyboard: [[{ text: '📢 Kanalga o\'tish', url: `https://t.me/${channel.replace('@', '')}` }]]
            }
          });
        }
      } catch (error) {
        console.error(`Failed to check subscription for ${channel}:`, error);
      }
    }
    return next();
  } catch (error) {
    console.error('Subscription check error:', error);
    return next();
  }
};

// Registration scene
const registrationScene = new Scenes.WizardScene(
  'registration',
  async (ctx) => {
    try {
      // Check channel subscription first
      const channels = process.env.REQUIRED_CHANNELS.split(',');
      for (const channel of channels) {
        try {
          const member = await ctx.telegram.getChatMember(channel, ctx.from.id);
          if (!['creator', 'administrator', 'member'].includes(member.status)) {
            return ctx.reply(`❌ Botdan foydalanish uchun ${channel} kanaliga obuna bo'ling!`, {
              reply_markup: {
                inline_keyboard: [[{ text: '📢 Kanalga o\'tish', url: `https://t.me/${channel.replace('@', '')}` }]]
              }
            });
          }
        } catch (error) {
          console.error(`Failed to check subscription for ${channel}:`, error);
        }
      }

      ctx.reply('Ismingizni kiriting:');
      return ctx.wizard.next();
    } catch (error) {
      console.error('Registration start error:', error);
      ctx.reply('❌ Xatolik yuz berdi. Iltimos qayta urinib ko\'ring.');
      return ctx.scene.leave();
    }
  },
  async (ctx) => {
    if (!ctx.message?.text) {
      ctx.reply('❌ Iltimos, ismingizni text formatida kiriting.');
      return;
    }
    ctx.session.firstName = ctx.message.text;
    ctx.reply('Familiyangizni kiriting:');
    return ctx.wizard.next();
  },
  async (ctx) => {
    if (!ctx.message?.text) {
      ctx.reply('❌ Iltimos, familiyangizni text formatida kiriting.');
      return;
    }
    ctx.session.lastName = ctx.message.text;
    ctx.reply('📱 Telefon raqamingizni yuborish uchun "Telefon raqamni yuborish" tugmasini bosing:', {
      reply_markup: {
        keyboard: [[{
          text: '📱 Telefon raqamni yuborish',
          request_contact: true
        }]],
        resize_keyboard: true,
        one_time_keyboard: true
      }
    });
    return ctx.wizard.next();
  },
  async (ctx) => {
    try {
      if (!ctx.message?.contact) {
        ctx.reply('❌ Iltimos, "Telefon raqamni yuborish" tugmasini bosing.');
        return;
      }

      // Verify that the contact belongs to the user
      if (ctx.message.contact.user_id !== ctx.from.id) {
        ctx.reply('❌ Iltimos, o\'zingizning telefon raqamingizni yuboring.');
        return;
      }

      const isUserTeacher = isTeacher(ctx.from.id);
      await users.insertOne({
        telegramId: ctx.from.id,
        firstName: ctx.session.firstName,
        lastName: ctx.session.lastName,
        phoneNumber: ctx.message.contact.phone_number,
        role: isUserTeacher ? 'TEACHER' : 'STUDENT',
        createdAt: new Date(),
        updatedAt: new Date()
      });

      await ctx.reply(`✅ ${isUserTeacher ? 'O\'qituvchi' : 'O\'quvchi'} sifatida ro\'yxatdan o\'tdingiz!`, {
        reply_markup: {
          remove_keyboard: true
        }
      });
      await showMainMenu(ctx, isUserTeacher ? 'TEACHER' : 'STUDENT');
      return ctx.scene.leave();
    } catch (error) {
      console.error('Registration error:', error);
      ctx.reply('❌ Xatolik yuz berdi. Iltimos qayta urinib ko\'ring.');
      return ctx.scene.leave();
    }
  }
);

// Create test scene
const createTestScene = new Scenes.WizardScene(
  'createTest',
  async (ctx) => {
    if (!isTeacher(ctx.from.id)) {
      ctx.reply('❌ Sizda o\'qituvchi huquqlari yo\'q');
      return ctx.scene.leave();
    }
    ctx.reply('📝 Test mavzusini kiriting:');
    return ctx.wizard.next();
  },
  async (ctx) => {
    ctx.session.testTitle = ctx.message.text;
    ctx.reply('📋 Test javoblarini kiriting (har bir javob yangi qatorda, masalan:\n1-a\n2-b\n3-c\n...)');
    return ctx.wizard.next();
  },
  async (ctx) => {
    const answers = ctx.message.text.split('\n')
      .map(line => line.trim())
      .filter(line => /^\d+-[a-d]$/i.test(line));

    if (answers.length === 0) {
      ctx.reply('❌ Noto\'g\'ri format. Iltimos qaytadan kiriting (masalan: 1-a)');
      return;
    }

    ctx.session.testAnswers = answers;
    ctx.reply('⏰ Test muddatini kiriting (DD.MM.YYYY HH:mm formatida):');
    return ctx.wizard.next();
  },
  async (ctx) => {
    try {
      const deadline = moment(ctx.message.text, 'DD.MM.YYYY HH:mm');
      if (!deadline.isValid()) {
        ctx.reply('❌ Noto\'g\'ri sana formati. Iltimos qaytadan kiriting (DD.MM.YYYY HH:mm):');
        return;
      }

      const test = await tests.insertOne({
        title: ctx.session.testTitle,
        answers: ctx.session.testAnswers,
        deadline: deadline.toDate(),
        createdBy: ctx.from.id,
        createdAt: new Date(),
        updatedAt: new Date()
      });

      await ctx.reply('✅ Test muvaffaqiyatli yaratildi!');

      // Send test info
      const buttons = [
        [
          { text: '✏️ Tahrirlash', callback_data: `edit_${test.insertedId}` },
          { text: '📊 Natijalar', callback_data: `results_${test.insertedId}` },
          { text: '🗑 O\'chirish', callback_data: `delete_${test.insertedId}` }
        ],
        [{ text: '📥 Natijalarni yuklab olish', callback_data: `download_${test.insertedId}` }]
      ];

      await ctx.reply(
        `📋 Test: ${ctx.session.testTitle}\n` +
        `📝 Savollar soni: ${ctx.session.testAnswers.length}\n` +
        `⏰ Muddat: ${deadline.format('DD.MM.YYYY HH:mm')}`,
        {
          reply_markup: {
            inline_keyboard: buttons
          }
        }
      );

      await showMainMenu(ctx, 'TEACHER');
      return ctx.scene.leave();
    } catch (error) {
      console.error('Test creation error:', error);
      ctx.reply('❌ Xatolik yuz berdi. Iltimos qayta urinib ko\'ring.');
      return ctx.scene.leave();
    }
  }
);

// Edit test scene
const editTestScene = new Scenes.WizardScene(
  'editTest',
  async (ctx) => {
    try {
      const testId = ctx.session.editingTest;
      const test = await tests.findOne({ _id: new ObjectId(testId) });
      
      if (!test) {
        ctx.reply('❌ Test topilmadi');
        return ctx.scene.leave();
      }

      ctx.session.currentTest = test;
      ctx.reply(
        '📝 Test ma\'lumotlarini tahrirlash\n\n' +
        'Nima o\'zgartirmoqchisiz?\n\n' +
        '1. Test mavzusi\n' +
        '2. Test javoblari\n' +
        '3. Test muddati\n\n' +
        'Raqamni tanlang yoki "bekor" deb yozing',
        {
          reply_markup: {
            keyboard: [['1', '2', '3'], ['bekor']],
            resize_keyboard: true,
            one_time_keyboard: true
          }
        }
      );
      return ctx.wizard.next();
    } catch (error) {
      console.error('Edit test scene error:', error);
      ctx.reply('❌ Xatolik yuz berdi. Iltimos qayta urinib ko\'ring.');
      return ctx.scene.leave();
    }
  },
  async (ctx) => {
    if (ctx.message.text === 'bekor') {
      await showMainMenu(ctx, 'TEACHER');
      return ctx.scene.leave();
    }

    const choice = parseInt(ctx.message.text);
    if (![1, 2, 3].includes(choice)) {
      ctx.reply('❌ Noto\'g\'ri tanlov. 1, 2, 3 raqamlaridan birini tanlang yoki "bekor" deb yozing');
      return;
    }

    ctx.session.editChoice = choice;
    switch (choice) {
      case 1:
        ctx.reply('📝 Yangi test mavzusini kiriting:');
        break;
      case 2:
        ctx.reply(
          '📋 Yangi test javoblarini kiriting (har bir javob yangi qatorda):\n' +
          'Masalan:\n1-a\n2-b\n3-c'
        );
        break;
      case 3:
        ctx.reply('⏰ Yangi test muddatini kiriting (DD.MM.YYYY HH:mm):');
        break;
    }
    return ctx.wizard.next();
  },
  async (ctx) => {
    try {
      const testId = ctx.session.editingTest;
      const choice = ctx.session.editChoice;
      const update = {};

      switch (choice) {
        case 1:
          update.title = ctx.message.text;
          break;
        case 2:
          const answers = ctx.message.text.split('\n')
            .map(line => line.trim())
            .filter(line => /^\d+-[a-d]$/i.test(line));
          if (answers.length === 0) {
            ctx.reply('❌ Noto\'g\'ri format. Iltimos qaytadan kiriting (masalan: 1-a)');
            return;
          }
          update.answers = answers;
          break;
        case 3:
          const deadline = moment(ctx.message.text, 'DD.MM.YYYY HH:mm');
          if (!deadline.isValid()) {
            ctx.reply('❌ Noto\'g\'ri sana formati. Iltimos qaytadan kiriting (DD.MM.YYYY HH:mm):');
            return;
          }
          update.deadline = deadline.toDate();
          break;
      }

      update.updatedAt = new Date();

      await tests.updateOne(
        { _id: new ObjectId(testId) },
        { $set: update }
      );

      await ctx.reply('✅ Test muvaffaqiyatli yangilandi!');
      await showMainMenu(ctx, 'TEACHER');
      return ctx.scene.leave();
    } catch (error) {
      console.error('Update test error:', error);
      ctx.reply('❌ Xatolik yuz berdi. Iltimos qayta urinib ko\'ring.');
      return ctx.scene.leave();
    }
  }
);

// Register scenes
const stage = new Scenes.Stage([registrationScene, createTestScene, editTestScene]);
bot.use(stage.middleware());

// Start command
bot.command('start', async (ctx) => {
  try {
    await ctx.reply('👋 Xush kelibsiz!');
    const user = await users.findOne({ telegramId: ctx.from.id });

    if (!user) {
      return ctx.scene.enter('registration');
    }

    return showMainMenu(ctx, isTeacher(ctx.from.id) ? 'TEACHER' : 'STUDENT');
  } catch (error) {
    console.error('Start command error:', error);
    ctx.reply('❌ Xatolik yuz berdi. Iltimos qayta urinib ko\'ring.');
  }
});

// Helper function to show main menu
const showMainMenu = async (ctx, role) => {
  try {
    const buttons = role === 'TEACHER' ? [
      [{ text: '📝 Test yaratish' }],
      [{ text: '📊 Testlarni boshqarish' }],
      [{ text: '📈 Natijalarni ko\'rish' }]
    ] : [
      [{ text: '📚 Mavjud testlar' }],
      [{ text: '🎯 Mening natijalarim' }]
    ];

    await ctx.reply('📱 Asosiy menyu:', {
      reply_markup: {
        keyboard: buttons,
        resize_keyboard: true
      }
    });
  } catch (error) {
    console.error('Show menu error:', error);
    ctx.reply('❌ Xatolik yuz berdi. Iltimos qayta urinib ko\'ring.');
  }
};

// Teacher commands
bot.hears('📝 Test yaratish', async (ctx) => {
  try {
    if (!isTeacher(ctx.from.id)) {
      return ctx.reply('❌ Sizda o\'qituvchi huquqlari yo\'q');
    }
    return ctx.scene.enter('createTest');
  } catch (error) {
    console.error('Create test error:', error);
    ctx.reply('❌ Xatolik yuz berdi. Iltimos qayta urinib ko\'ring.');
  }
});

bot.hears('📚 Mening testlarim', async (ctx) => {
  try {
    if (!isTeacher(ctx.from.id)) {
      return ctx.reply('❌ Sizda o\'qituvchi huquqlari yo\'q');
    }

    const userTests = await tests.find({ 
      createdBy: ctx.from.id 
    }).sort({ 
      createdAt: 1  // Sort by creation date, oldest first
    }).toArray();

    if (userTests.length === 0) {
      return ctx.reply('📭 Hozircha testlar yo\'q');
    }

    let message = '📚 Sizning testlaringiz:\n\n';
    const buttons = [];
    
    for (const test of userTests) {
      const testResults = await testResults.countDocuments({ testId: test._id });
      message += `📋 ${test.title}\n`;
      message += `📝 Savollar soni: ${test.answers.length}\n`;
      message += `✍️ Topshirganlar soni: ${testResults}\n`;
      message += `📅 Yaratilgan vaqt: ${moment(test.createdAt).format('DD.MM.YYYY HH:mm')}\n\n`;
      
      // Add row of buttons for each test
      buttons.push([
        { text: `✏️ ${test.title}`, callback_data: `manage_${test._id}` },
        { text: '📊 Natijalar', callback_data: `download_${test._id}` }
      ]);
    }

    await ctx.reply(message, {
      reply_markup: {
        inline_keyboard: buttons
      }
    });
  } catch (error) {
    console.error('Tests list error:', error);
    ctx.reply('❌ Xatolik yuz berdi. Iltimos qayta urinib ko\'ring.');
  }
});

bot.hears('📊 Testlarni boshqarish', async (ctx) => {
  try {
    if (!isTeacher(ctx.from.id)) {
      return ctx.reply('❌ Sizda o\'qituvchi huquqlari yo\'q');
    }

    const userTests = await tests.find({ 
      createdBy: ctx.from.id 
    })
    .sort({ createdAt: 1 }) // Sort by creation date, oldest first
    .toArray();
    
    if (userTests.length === 0) {
      return ctx.reply('📭 Hozircha testlar yo\'q');
    }

    for (const test of userTests) {
      const teacher = await users.findOne({ telegramId: test.createdBy });
      const buttons = [
        [
          { text: '✏️ Tahrirlash', callback_data: `edit_${test._id}` },
          { text: '📊 Natijalar', callback_data: `results_${test._id}` },
          { text: '🗑 O\'chirish', callback_data: `delete_${test._id}` }
        ],
        [{ text: '📥 Natijalarni yuklab olish', callback_data: `download_${test._id}` }]
      ];

      await ctx.reply(
        `📋 Test: ${test.title}\n` +
        `👨‍🏫 O'qituvchi: ${teacher?.firstName || 'Noma\'lum'} ${teacher?.lastName || ''}\n` +
        `📝 Savollar soni: ${test.answers.length}\n` +
        `⏰ Muddat: ${moment(test.deadline).format('DD.MM.YYYY HH:mm')}`,
        {
          reply_markup: {
            inline_keyboard: buttons
          }
        }
      );
    }
  } catch (error) {
    console.error('Manage tests error:', error);
    ctx.reply('❌ Xatolik yuz berdi. Iltimos qayta urinib ko\'ring.');
  }
});

bot.hears('📈 Natijalarni ko\'rish', async (ctx) => {
  try {
    if (!isTeacher(ctx.from.id)) {
      return ctx.reply('❌ Sizda o\'qituvchi huquqlari yo\'q');
    }

    const userTests = await tests.find({ createdBy: ctx.from.id }).toArray();
    
    if (userTests.length === 0) {
      return ctx.reply('📭 Hozircha testlar yo\'q');
    }

    const buttons = userTests.map(test => [{
      text: `📊 ${test.title}`,
      callback_data: `results_${test._id}`
    }]);

    ctx.reply('📈 Qaysi testning natijalarini ko\'rmoqchisiz?', {
      reply_markup: {
        inline_keyboard: buttons
      }
    });
  } catch (error) {
    console.error('View results error:', error);
    ctx.reply('❌ Xatolik yuz berdi. Iltimos qayta urinib ko\'ring.');
  }
});

// Handle test results
bot.action(/results_(.+)/, async (ctx) => {
  try {
    const testId = ctx.match[1];
    const test = await tests.findOne({ _id: new ObjectId(testId) });
    
    if (!test) {
      return ctx.reply('❌ Test topilmadi');
    }

    if (test.createdBy !== ctx.from.id && ctx.from.id !== ADMIN_ID) {
      return ctx.reply('❌ Siz faqat o\'zingiz yaratgan testlarning natijalarini ko\'ra olasiz');
    }

    const results = await testResults.aggregate([
      { $match: { testId: new ObjectId(testId) } },
      {
        $lookup: {
          from: 'users',
          localField: 'userId',
          foreignField: 'telegramId',
          as: 'user'
        }
      },
      { $unwind: '$user' },
      { $sort: { submittedAt: -1 } } // Sort by submission date, newest first
    ]).toArray();

    if (results.length === 0) {
      return ctx.reply('📭 Bu test uchun natijalar yo\'q');
    }

    // Format results message
    let message = `📊 ${test.title} - Natijalar:\n\n`;
    for (const result of results) {
      const color = result.score >= 80 ? '🟢' : result.score >= 60 ? '🟡' : '🔴';
      message += `${color} ${result.user.firstName} ${result.user.lastName}: ${result.score.toFixed(1)}%\n`;
    }

    // Add Excel download button
    const buttons = [[{ text: '📥 Excel yuklash', callback_data: `download_${testId}` }]];

    await ctx.reply(message, {
      reply_markup: {
        inline_keyboard: buttons
      }
    });
  } catch (error) {
    console.error('View test results error:', error);
    ctx.reply('❌ Xatolik yuz berdi. Iltimos qayta urinib ko\'ring.');
  }
});

// Handle test deletion
bot.action(/delete_(.+)/, async (ctx) => {
  try {
    const testId = ctx.match[1];
    const test = await tests.findOne({ _id: new ObjectId(testId) });
    
    if (!test) {
      return ctx.reply('❌ Test topilmadi');
    }

    if (test.createdBy !== ctx.from.id && ctx.from.id !== ADMIN_ID) {
      return ctx.reply('❌ Siz faqat o\'zingiz yaratgan testlarni o\'chira olasiz');
    }

    await tests.deleteOne({ _id: new ObjectId(testId) });
    await testResults.deleteMany({ testId: new ObjectId(testId) });

    await ctx.reply('✅ Test muvaffaqiyatli o\'chirildi');
    await ctx.answerCbQuery();
  } catch (error) {
    console.error('Delete test error:', error);
    ctx.reply('❌ Xatolik yuz berdi. Iltimos qayta urinib ko\'ring.');
  }
});

// Handle test editing
bot.action(/edit_(.+)/, async (ctx) => {
  try {
    const testId = ctx.match[1];
    const test = await tests.findOne({ _id: new ObjectId(testId) });
    
    if (!test) {
      return ctx.reply('❌ Test topilmadi');
    }

    if (test.createdBy !== ctx.from.id && ctx.from.id !== ADMIN_ID) {
      return ctx.reply('❌ Siz faqat o\'zingiz yaratgan testlarni tahrirlashingiz mumkin');
    }

    ctx.session.editingTest = testId;
    ctx.scene.enter('editTest');
    await ctx.answerCbQuery();
  } catch (error) {
    console.error('Edit test error:', error);
    ctx.reply('❌ Xatolik yuz berdi. Iltimos qayta urinib ko\'ring.');
  }
});

// Student commands
bot.hears('📚 Mavjud testlar', async (ctx) => {
  try {
    const availableTests = await tests.find({
      deadline: { $gt: new Date() }
    })
    .sort({ createdAt: 1 }) // Sort by creation date, oldest first
    .toArray();

    if (availableTests.length === 0) {
      return ctx.reply('📭 Hozircha mavjud testlar yo\'q');
    }

    for (const test of availableTests) {
      const teacher = await users.findOne({ telegramId: test.createdBy });
      const studentResult = await testResults.findOne({
        testId: test._id,
        userId: ctx.from.id
      });
      
      let status;
      let buttonText;
      
      if (studentResult) {
        status = `✅ Ishlangan (${studentResult.score.toFixed(1)}%)`;
        buttonText = `✅ Ishlangan (${studentResult.score.toFixed(1)}%)`;
      } else if (test.deadline && new Date(test.deadline) < new Date()) {
        status = '⌛️ Muddat tugagan';
        buttonText = '⌛️ Muddat tugagan';
      } else {
        status = '🆕 Yangi';
        buttonText = '✍️ Testni boshlash';
      }

      await ctx.reply(
        `📋 Test: ${test.title}\n` +
        `👨‍🏫 O'qituvchi: ${teacher?.firstName || 'Noma\'lum'} ${teacher?.lastName || ''}\n` +
        `📝 Savollar soni: ${test.answers.length}\n` +
        `⏰ Muddat: ${moment(test.deadline).format('DD.MM.YYYY HH:mm')}\n` +
        `📊 Holat: ${status}`,
        {
          reply_markup: {
            inline_keyboard: [[
              { text: buttonText, callback_data: `take_${test._id}` }
            ]]
          }
        }
      );
    }
  } catch (error) {
    console.error('Available tests error:', error);
    ctx.reply('❌ Xatolik yuz berdi. Iltimos qayta urinib ko\'ring.');
  }
});

bot.hears('🎯 Mening natijalarim', async (ctx) => {
  try {
    const results = await testResults.aggregate([
      { $match: { userId: ctx.from.id } },
      {
        $lookup: {
          from: 'tests',
          localField: 'testId',
          foreignField: '_id',
          as: 'test'
        }
      },
      { $unwind: '$test' },
      { $sort: { submittedAt: -1 } } // Sort by submission date, newest first
    ]).toArray();

    if (results.length === 0) {
      return ctx.reply('📭 Hozircha natijalar yo\'q');
    }

    let message = '🎯 Sizning natijalaringiz:\n\n';
    for (const result of results) {
      const color = result.score >= 80 ? '🟢' : result.score >= 60 ? '🟡' : '🔴';
      message += `📋 ${result.test.title}\n`;
      message += `${color} Ball: ${result.score.toFixed(1)}%\n`;
      message += `📅 Topshirilgan vaqt: ${moment(result.submittedAt).format('DD.MM.YYYY HH:mm')}\n\n`;
    }

    await ctx.reply(message);
  } catch (error) {
    console.error('Results error:', error);
    ctx.reply('❌ Xatolik yuz berdi. Iltimos qayta urinib ko\'ring.');
  }
});

// Admin commands
bot.hears('👥 Foydalanuvchilarni boshqarish', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) {
    return;
  }

  try {
    const allUsers = await users.find().toArray();
    let message = '👥 Foydalanuvchilar ro\'yxati:\n\n';
    
    for (const user of allUsers) {
      const role = user.role === 'TEACHER' ? '👨‍🏫' : '👨‍🎓';
      message += `${role} ${user.firstName} ${user.lastName}\n`;
      message += `🆔 ${user.telegramId}\n\n`;
    }

    ctx.reply(message, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '➕ O\'qituvchi qo\'shish', callback_data: 'add_teacher' }],
          [{ text: '➖ O\'qituvchini o\'chirish', callback_data: 'remove_teacher' }]
        ]
      }
    });
  } catch (error) {
    console.error('Users management error:', error);
    ctx.reply('❌ Xatolik yuz berdi. Iltimos qayta urinib ko\'ring.');
  }
});

// Download test results
bot.action(/download_(.+)/, async (ctx) => {
  try {
    const testId = ctx.match[1];
    
    // Get test details and results
    const test = await tests.findOne({ _id: new ObjectId(testId) });
    if (!test) {
      return ctx.reply('❌ Test topilmadi');
    }

    await ctx.reply('📊 Natijalar yuklanmoqda...');

    const results = await testResults.aggregate([
      { $match: { testId: new ObjectId(testId) } },
      {
        $lookup: {
          from: 'users',
          localField: 'userId',
          foreignField: 'telegramId',
          as: 'user'
        }
      },
      { $unwind: '$user' },
      { $sort: { score: -1 } }
    ]).toArray();

    if (results.length === 0) {
      return ctx.reply('❌ Bu test uchun hali natijalar yo\'q');
    }

    // Create document content
    const content = [];
    
    // Add title
    content.push('='.repeat(50) + '\n');
    content.push(' '.repeat(20) + test.title + '\n');
    content.push('='.repeat(50) + '\n\n');

    // Add test info
    content.push('TEST HAQIDA MA\'LUMOT\n');
    content.push('-'.repeat(30) + '\n');
    content.push(`Yaratilgan vaqt: ${moment(test.createdAt).format('DD.MM.YYYY HH:mm')}\n`);
    content.push(`Savollar soni: ${test.answers.length}\n`);
    content.push(`Test yaratuvchi: ${test.createdByName || "Noma'lum"}\n`);
    content.push(`Jami qatnashchilar: ${results.length}\n\n`);

    // Add results
    content.push('NATIJALAR\n');
    content.push('-'.repeat(30) + '\n');
    content.push('№  | F.I.SH                 | Ball  | To\'g\'ri/Noto\'g\'ri | Status\n');
    content.push('-'.repeat(70) + '\n');
    
    results.forEach((result, index) => {
      const name = result.user ? `${result.user.lastName || ''} ${result.user.firstName || ''}`.padEnd(20) : 'Noma\'lum'.padEnd(20);
      const score = `${(result.score || 0).toFixed(1)}%`.padEnd(6);
      const answers = `${result.correctAnswers || 0}/${result.wrongAnswers || 0}`.padEnd(15);
      const status = (result.score || 0) >= 80 ? "🟢 A'lo" : (result.score || 0) >= 60 ? "🟡 Yaxshi" : "🔴 Qoniqarsiz";
      content.push(`${(index + 1).toString().padStart(2)}  | ${name} | ${score} | ${answers} | ${status}\n`);
    });
    content.push('\n');

    // Add statistics
    content.push('STATISTIKA\n');
    content.push('-'.repeat(30) + '\n');
    const scores = results.map(r => r.score || 0);
    const avgScore = (scores.reduce((sum, score) => sum + score, 0) / scores.length).toFixed(1);
    const maxScore = Math.max(...scores).toFixed(1);
    const minScore = Math.min(...scores).toFixed(1);
    
    content.push(`O'rtacha ball: ${avgScore}%\n`);
    content.push(`Eng yuqori ball: ${maxScore}%\n`);
    content.push(`Eng past ball: ${minScore}%\n`);
    content.push(`A'lo baholar: ${results.filter(r => (r.score || 0) >= 80).length}\n`);
    content.push(`Yaxshi baholar: ${results.filter(r => (r.score || 0) >= 60 && (r.score || 0) < 80).length}\n`);
    content.push(`Qoniqarsiz baholar: ${results.filter(r => (r.score || 0) < 60).length}\n`);

    // Create filename and send
    const date = moment().format('DD_MM_YYYY_HH_mm');
    const safeTitle = test.title.replace(/[^a-zA-Z0-9\-_]/g, '_').substring(0, 30);
    const filename = `${safeTitle}_${date}.txt`;

    await ctx.replyWithDocument({
      source: Buffer.from(content.join(''), 'utf8'),
      filename: filename
    }, {
      caption: `📄 ${test.title}\n📅 ${moment().format('DD.MM.YYYY HH:mm')}`
    });

    await ctx.reply('✅ Natijalar muvaffaqiyatli yuklandi!');
  } catch (error) {
    console.error('Download error:', error);
    ctx.reply('❌ Xatolik yuz berdi. Iltimos qayta urinib ko\'ring.');
  }
});

// Handle taking tests
bot.action(/take_(.+)/, async (ctx) => {
  try {
    const testId = ctx.match[1];
    const test = await tests.findOne({ _id: new ObjectId(testId) });
    
    if (!test) {
      return ctx.reply('Test topilmadi.');
    }

    if (test.deadline < new Date()) {
      return ctx.reply('Ushbu testning muddati tugagan.');
    }

    // Check if user already took this test
    const existingResult = await testResults.findOne({
      userId: ctx.from.id,
      testId: new ObjectId(testId)
    });

    if (existingResult) {
      return ctx.reply('Siz bu testni allaqachon topshirgansiz.');
    }

    await ctx.reply(
      `📝 ${test.title} testi.\n\n` +
      `Savollar soni: ${test.answers.length}\n` +
      `⏰ Muddat: ${moment(test.deadline).format('DD.MM.YYYY HH:mm')}\n\n` +
      `Javoblarni quyidagi formatda yuboring:\n` +
      `1-a\n2-b\n3-c\n...\n\n` +
      `Eslatma: Barcha javoblarni bir xabarda yuborish kerak!`
    );
    
    // Save test ID to session
    ctx.session.currentTest = testId;
    await ctx.answerCbQuery();
  } catch (error) {
    console.error('Take test error:', error);
    ctx.reply('❌ Xatolik yuz berdi. Iltimos qayta urinib ko\'ring.');
  }
});

// Handle test answers
bot.on('text', async (ctx) => {
  if (!ctx.session?.currentTest && !ctx.session?.editingTest) {
    return;
  }

  try {
    if (ctx.session.currentTest) {
      const testId = ctx.session.currentTest;
      const test = await tests.findOne({ _id: new ObjectId(testId) });
      
      if (!test) {
        delete ctx.session.currentTest;
        return ctx.reply('Test topilmadi.');
      }

      if (test.deadline < new Date()) {
        delete ctx.session.currentTest;
        return ctx.reply('Testning muddati tugagan.');
      }

      const userAnswers = ctx.message.text.split('\n')
        .map(line => line.trim().toLowerCase())
        .filter(line => /^\d+-[a-d]$/i.test(line));

      if (userAnswers.length === 0) {
        return ctx.reply(
          'Noto\'g\'ri format. Javoblarni quyidagi formatda yuboring:\n' +
          '1-a\n2-b\n3-c\n...'
        );
      }

      if (userAnswers.length !== test.answers.length) {
        return ctx.reply(
          `Barcha savollarga javob bermadingiz.\n` +
          `Savollar soni: ${test.answers.length}\n` +
          `Sizning javoblaringiz: ${userAnswers.length}`
        );
      }

      // Compare answers and calculate score
      const correctAnswers = test.answers.map(a => a.toLowerCase());
      let correctCount = 0;

      userAnswers.forEach(answer => {
        if (correctAnswers.includes(answer)) {
          correctCount++;
        }
      });

      const score = (correctCount / test.answers.length) * 100;

      // Save result
      await testResults.insertOne({
        userId: ctx.from.id,
        testId: new ObjectId(test._id),
        answers: userAnswers,
        score,
        submittedAt: new Date()
      });

      // Clear current test from session
      delete ctx.session.currentTest;

      // Send result with appropriate color and emoji
      const color = score >= 80 ? '🟢' : score >= 60 ? '🟡' : '🔴';
      const emoji = score >= 80 ? '🎉' : score >= 60 ? '👍' : '😕';
      
      await ctx.reply(
        `${emoji} Test natijasi:\n\n` +
        `${color} Ball: ${score.toFixed(1)}%\n` +
        `✅ To'g'ri javoblar: ${correctCount} ta\n` +
        `❌ Noto'g'ri javoblar: ${test.answers.length - correctCount} ta`
      );
    } else if (ctx.session.editingTest && ctx.session.editingField) {
      const testId = ctx.session.editingTest;
      const field = ctx.session.editingField;
      const test = await tests.findOne({ _id: new ObjectId(testId) });

      if (!test) {
        delete ctx.session.editingTest;
        delete ctx.session.editingField;
        return ctx.reply('Test topilmadi.');
      }

      let updateData = {};

      switch (field) {
        case 'title':
          updateData = { title: ctx.message.text };
          break;

        case 'answers':
          const answers = ctx.message.text.split('\n');
          if (!answers.every(answer => /^\d+-[a-d]$/i.test(answer.trim()))) {
            return ctx.reply('Noto\'g\'ri format. Iltimos qaytadan kiriting (masalan: 1-a)');
          }
          updateData = { answers };
          break;

        case 'deadline':
          const deadline = moment(ctx.message.text, 'DD.MM.YYYY HH:mm');
          if (!deadline.isValid()) {
            return ctx.reply('Noto\'g\'ri sana formati. Iltimos qaytadan kiriting (DD.MM.YYYY HH:mm):');
          }
          updateData = { deadline: deadline.toDate() };
          break;
      }

      await tests.updateOne(
        { _id: new ObjectId(test._id) },
        { 
          $set: {
            ...updateData,
            updatedAt: new Date()
          }
        }
      );

      delete ctx.session.editingTest;
      delete ctx.session.editingField;

      ctx.reply('O\'zgarishlar muvaffaqiyatli saqlandi.');
    }
  } catch (error) {
    console.error('Process text error:', error);
    ctx.reply('❌ Xatolik yuz berdi. Iltimos qayta urinib ko\'ring.');
  }
});

// Add teacher
bot.action('add_teacher', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) {
    return;
  }

  ctx.reply('O\'qituvchi qilmoqchi bo\'lgan foydalanuvchining ID raqamini yuboring:');
  ctx.session.awaitingTeacherId = true;
});

// Remove teacher
bot.action('remove_teacher', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) {
    return;
  }

  ctx.reply('O\'qituvchi rolini olib tashlamoqchi bo\'lgan foydalanuvchining ID raqamini yuboring:');
  ctx.session.awaitingRemoveTeacherId = true;
});

// Handle teacher management
bot.on('text', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) {
    return;
  }

  try {
    if (ctx.session.awaitingTeacherId) {
      const teacherId = parseInt(ctx.message.text);
      if (isNaN(teacherId)) {
        return ctx.reply('Noto\'g\'ri ID format.');
      }

      await users.updateOne(
        { telegramId: teacherId },
        { $set: { role: 'TEACHER', updatedAt: new Date() } }
      );

      delete ctx.session.awaitingTeacherId;
      ctx.reply('Foydalanuvchi o\'qituvchi qilib tayinlandi!');
    }
    else if (ctx.session.awaitingRemoveTeacherId) {
      const teacherId = parseInt(ctx.message.text);
      if (isNaN(teacherId)) {
        return ctx.reply('Noto\'g\'ri ID format.');
      }

      if (teacherId === ADMIN_ID) {
        return ctx.reply('Admin rolini o\'zgartirib bo\'lmaydi!');
      }

      await users.updateOne(
        { telegramId: teacherId },
        { $set: { role: 'STUDENT', updatedAt: new Date() } }
      );

      delete ctx.session.awaitingRemoveTeacherId;
      ctx.reply('O\'qituvchi roli olib tashlandi!');
    }
  } catch (error) {
    console.error('Teacher management error:', error);
    ctx.reply('❌ Xatolik yuz berdi. Iltimos qayta urinib ko\'ring.');
  }
});

// Show teacher's tests
bot.hears('📊 Testlarni boshqarish', async (ctx) => {
  try {
    if (!isTeacher(ctx.from.id)) {
      return ctx.reply('❌ Sizda o\'qituvchi huquqlari yo\'q');
    }

    const userTests = await tests.find({ 
      createdBy: ctx.from.id 
    }).sort({ 
      createdAt: 1 
    }).toArray();

    if (userTests.length === 0) {
      return ctx.reply('📭 Hozircha testlar yo\'q');
    }

    let message = '📊 Testlar ro\'yxati:\n\n';
    for (const test of userTests) {
      const testResults = await testResults.countDocuments({ testId: test._id });
      message += `📋 ${test.title}\n`;
      message += `📝 Savollar soni: ${test.questions.length}\n`;
      message += `✍️ Topshirganlar soni: ${testResults}\n`;
      message += `📅 Yaratilgan vaqt: ${moment(test.createdAt).format('DD.MM.YYYY HH:mm')}\n\n`;
    }

    await ctx.reply(message, {
      reply_markup: {
        inline_keyboard: userTests.map(test => [
          { text: `📋 ${test.title}`, callback_data: `manage_${test._id}` }
        ])
      }
    });
  } catch (error) {
    console.error('Tests management error:', error);
    ctx.reply('❌ Xatolik yuz berdi. Iltimos qayta urinib ko\'ring.');
  }
});

// Handle test management
bot.action(/manage_(.+)/, async (ctx) => {
  try {
    const testId = ctx.match[1];
    const test = await tests.findOne({ _id: new ObjectId(testId) });
    if (!test) {
      return ctx.reply('❌ Test topilmadi');
    }

    const testResults = await testResults.countDocuments({ testId: new ObjectId(testId) });

    let message = `📋 ${test.title}\n`;
    message += `📝 Savollar soni: ${test.questions.length}\n`;
    message += `✍️ Topshirganlar soni: ${testResults}\n`;
    message += `📅 Yaratilgan vaqt: ${moment(test.createdAt).format('DD.MM.YYYY HH:mm')}`;

    await ctx.reply(message, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✏️ Tahrirlash', callback_data: `edit_${testId}` },
            { text: '📊 Natijalar', callback_data: `results_${testId}` }
          ],
          [
            { text: '📥 Natijalarni yuklab olish', callback_data: `download_${testId}` }
          ],
          [
            { text: '🗑 O\'chirish', callback_data: `delete_${testId}` }
          ]
        ]
      }
    });
  } catch (error) {
    console.error('Error in manage action:', error);
    await ctx.reply('❌ Xatolik yuz berdi. Iltimos qaytadan urinib ko\'ring.');
  }
});

// Handle test results download
bot.action(/download_(.+)/, async (ctx) => {
  try {
    const testId = ctx.match[1];
    
    // Get test details and results
    const test = await tests.findOne({ _id: new ObjectId(testId) });
    if (!test) {
      return ctx.reply('❌ Test topilmadi');
    }

    await ctx.reply('📊 Natijalar yuklanmoqda...');

    const results = await testResults.aggregate([
      { $match: { testId: new ObjectId(testId) } },
      {
        $lookup: {
          from: 'users',
          localField: 'userId',
          foreignField: 'telegramId',
          as: 'user'
        }
      },
      { $unwind: '$user' },
      { $sort: { score: -1 } }
    ]).toArray();

    if (results.length === 0) {
      return ctx.reply('❌ Bu test uchun hali natijalar yo\'q');
    }

    // Create document content
    const content = [];
    
    // Add title
    content.push('='.repeat(50) + '\n');
    content.push(' '.repeat(20) + test.title + '\n');
    content.push('='.repeat(50) + '\n\n');

    // Add test info
    content.push('TEST HAQIDA MA\'LUMOT\n');
    content.push('-'.repeat(30) + '\n');
    content.push(`Yaratilgan vaqt: ${moment(test.createdAt).format('DD.MM.YYYY HH:mm')}\n`);
    content.push(`Savollar soni: ${test.questions ? test.questions.length : 0}\n`);
    content.push(`Test yaratuvchi: ${test.createdByName || "Noma'lum"}\n`);
    content.push(`Jami qatnashchilar: ${results.length}\n\n`);

    // Add results
    content.push('NATIJALAR\n');
    content.push('-'.repeat(30) + '\n');
    content.push('№  | F.I.SH                 | Ball  | To\'g\'ri/Noto\'g\'ri | Status\n');
    content.push('-'.repeat(70) + '\n');
    results.forEach((result, index) => {
      const name = result.user ? `${result.user.lastName || ''} ${result.user.firstName || ''}`.padEnd(20) : 'Noma\'lum'.padEnd(20);
      const score = `${(result.score || 0).toFixed(1)}%`.padEnd(6);
      const answers = `${result.correctAnswers || 0}/${result.wrongAnswers || 0}`.padEnd(15);
      const status = (result.score || 0) >= 80 ? "🟢 A'lo" : (result.score || 0) >= 60 ? "🟡 Yaxshi" : "🔴 Qoniqarsiz";
      content.push(`${(index + 1).toString().padStart(2)}  | ${name} | ${score} | ${answers} | ${status}\n`);
    });
    content.push('\n');

    // Add statistics
    content.push('STATISTIKA\n');
    content.push('-'.repeat(30) + '\n');
    const scores = results.map(r => r.score || 0);
    const avgScore = (scores.reduce((sum, score) => sum + score, 0) / scores.length).toFixed(1);
    const maxScore = Math.max(...scores).toFixed(1);
    const minScore = Math.min(...scores).toFixed(1);
    
    content.push(`O'rtacha ball: ${avgScore}%\n`);
    content.push(`Eng yuqori ball: ${maxScore}%\n`);
    content.push(`Eng past ball: ${minScore}%\n`);
    content.push(`A'lo baholar: ${results.filter(r => (r.score || 0) >= 80).length}\n`);
    content.push(`Yaxshi baholar: ${results.filter(r => (r.score || 0) >= 60 && (r.score || 0) < 80).length}\n`);
    content.push(`Qoniqarsiz baholar: ${results.filter(r => (r.score || 0) < 60).length}\n`);

    // Create filename and send
    const date = moment().format('DD_MM_YYYY_HH_mm');
    const safeTitle = test.title.replace(/[^a-zA-Z0-9\-_]/g, '_').substring(0, 30);
    const filename = `${safeTitle}_${date}.txt`;

    await ctx.replyWithDocument({
      source: Buffer.from(content.join(''), 'utf8'),
      filename: filename
    }, {
      caption: `📄 ${test.title}\n📅 ${moment().format('DD.MM.YYYY HH:mm')}`
    });

    await ctx.reply('✅ Natijalar muvaffaqiyatli yuklandi!');
  } catch (error) {
    console.error('Download error:', error);
    ctx.reply('❌ Xatolik yuz berdi. Iltimos qayta urinib ko\'ring.');
  }
});

// Start the bot
async function startBot() {
  try {
    // Connect to MongoDB
    await client.connect();
    console.log('Connected to MongoDB');
    
    // Initialize database and collections
    db = client.db('test-bot');
    users = db.collection('users');
    tests = db.collection('tests');
    testResults = db.collection('testResults');

    // Create indexes
    await users.createIndex({ telegramId: 1 }, { unique: true });
    await tests.createIndex({ createdBy: 1 });
    await testResults.createIndex({ userId: 1 });
    await testResults.createIndex({ testId: 1 });

    // Start bot
    await bot.launch({
      dropPendingUpdates: true,
      allowedUpdates: ['message', 'callback_query', 'my_chat_member']
    });
    console.log('Bot started successfully');

    // Enable graceful stop
    process.once('SIGINT', async () => {
      console.log('Shutting down...');
      await bot.stop('SIGINT');
      await client.close();
    });
    process.once('SIGTERM', async () => {
      console.log('Shutting down...');
      await bot.stop('SIGTERM');
      await client.close();
    });
  } catch (error) {
    console.error('Failed to start:', error);
    await client.close();
    process.exit(1);
  }
}

startBot().catch(console.error);
