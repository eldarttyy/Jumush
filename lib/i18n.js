// Server-side translations: catalog, errors, notifications, SMS. Keys are the English text; {0},{1}… are params.
// Params that are themselves dictionary keys (service names, districts) are translated too.
'use strict';
const LANGS = ['ru', 'en'];

const RU = {
  // catalog
  'Cleaning': 'Уборка', 'Plumbing': 'Сантехника', 'Electrical': 'Электрика', 'Appliance repair': 'Ремонт техники', 'Handyman': 'Мастер на час', 'Moving help': 'Переезд и грузчики',
  'Standard apartment clean': 'Обычная уборка квартиры', 'Deep / post-renovation clean': 'Генеральная уборка / после ремонта', 'Window washing': 'Мытьё окон', 'Carpet cleaning': 'Чистка ковров',
  'Fix leaking tap': 'Ремонт протекающего крана', 'Unclog drain': 'Прочистка засора', 'Install toilet': 'Установка унитаза', 'Install water heater': 'Установка водонагревателя',
  'Install / replace socket': 'Установка / замена розетки', 'Install light fixture': 'Установка светильника', 'Find & fix fault': 'Поиск и устранение неисправности', 'Wire a room': 'Проводка в комнате',
  'Washing machine repair': 'Ремонт стиральной машины', 'Fridge repair': 'Ремонт холодильника', 'Install washing machine': 'Подключение стиральной машины',
  'Assemble furniture': 'Сборка мебели', 'Hang shelf / TV / mirror': 'Повесить полку / ТВ / зеркало', 'Install door lock': 'Установка дверного замка',
  'Movers (2 people)': 'Грузчики (2 человека)', 'Furniture disposal': 'Вывоз мебели',
  'per m²': 'за м²', 'per window': 'за окно', 'per tap': 'за кран', 'per drain': 'за засор', 'per unit': 'за шт.', 'per socket': 'за розетку', 'per fixture': 'за светильник',
  'per visit': 'за выезд', 'per room': 'за комнату', 'per item': 'за шт.', 'per lock': 'за замок', 'per hour': 'за час', 'per load': 'за рейс', 'quoted job': 'работа по смете',
  'Leninsky': 'Ленинский', 'Oktyabrsky': 'Октябрьский', 'Pervomaisky': 'Первомайский', 'Sverdlovsky': 'Свердловский',
  'weekly': 'еженедельный', 'biweekly': 'раз в 2 недели', 'monthly': 'ежемесячный',

  // errors
  'Please sign in': 'Пожалуйста, войдите', 'Not allowed': 'Нет доступа', 'Not found': 'Не найдено', 'Server error': 'Ошибка сервера', 'Bad JSON': 'Неверный запрос', 'Payload too large': 'Слишком большой запрос',
  'Enter a Kyrgyz number, e.g. 0700 123 456': 'Введите кыргызский номер, например 0700 123 456',
  'Please wait 30 seconds before requesting a new code': 'Подождите 30 секунд перед повторной отправкой кода',
  'Too many codes requested. Try again in an hour.': 'Слишком много запросов кода. Попробуйте через час.',
  'Could not send the SMS. Please try again.': 'Не удалось отправить SMS. Попробуйте ещё раз.',
  'Code expired, request a new one': 'Код истёк, запросите новый', 'Wrong code': 'Неверный код',
  'Upload type not allowed': 'Этот тип загрузки недоступен', 'Image must be under 4 MB': 'Фото должно быть меньше 4 МБ', 'Only JPEG, PNG or WebP images': 'Только изображения JPEG, PNG или WebP',
  'Portfolio is limited to 12 photos': 'В портфолио не больше 12 фото', 'Unknown service': 'Неизвестная услуга', 'Address and district are required': 'Укажите адрес и район',
  'Pick a time': 'Выберите время', 'Book at least {0} hours ahead': 'Бронируйте минимум за {0} ч.', 'This pro does not offer that service': 'Этот мастер не оказывает эту услугу',
  'That time is no longer available. Please pick another slot.': 'Это время уже занято. Выберите другое.',
  'Online payment is not available yet': 'Онлайн-оплата пока недоступна', 'The payment service is unavailable. Please try again.': 'Платёжный сервис недоступен. Попробуйте ещё раз.',
  'This booking is already paid or no longer active': 'Этот заказ уже оплачен или больше не активен',
  'This action is not available right now': 'Сейчас это действие недоступно', 'You are not verified for this category': 'Вы не подтверждены в этой категории',
  'You already have a job at this time': 'У вас уже есть заказ на это время', 'Job already taken': 'Заказ уже взял другой мастер', 'The warranty has expired': 'Срок гарантии истёк',
  'Rating must be 1–5': 'Оценка от 1 до 5', 'Unknown action': 'Неизвестное действие', 'Empty message': 'Пустое сообщение', 'Invalid signature': 'Неверная подпись',
  'Pick a category': 'Выберите категорию', 'Add a title and describe the job (at least 10 characters)': 'Добавьте название и опишите работу (минимум 10 символов)',
  'Pick a preferred date in the future': 'Выберите будущую дату', 'This request is no longer open': 'Эта заявка уже закрыта', 'Enter a price in som': 'Укажите цену в сомах',
  'Quote can no longer be changed': 'Предложение больше нельзя изменить', 'Finish or cancel the payment for your current choice first': 'Сначала оплатите или отмените текущий выбор',
  'You already hired someone for this request': 'Вы уже выбрали мастера для этой заявки', 'Quote not found': 'Предложение не найдено', 'Cannot close': 'Нельзя закрыть',
  'Nothing to withdraw': 'Нечего выводить', 'Bad decision': 'Неверное решение',

  // notifications
  'New pro signed up and needs verification': 'Новый мастер зарегистрировался и ждёт проверки',
  "You're hired! {0}: {1} som. The payment is held.": 'Вас выбрали! {0}: {1} сом. Оплата уже внесена.',
  'The client hired someone else for "{0}"': 'Клиент выбрал другого мастера для «{0}»',
  'Next recurring visit booked: {0}': 'Забронирован следующий регулярный визит: {0}',
  'New booking request: {0}': 'Новый заказ для вас: {0}', 'New job in {0}: {1}': 'Новый заказ ({0} р-н): {1}',
  'You received a {0} som tip for {1}': 'Вы получили чаевые {0} сом за «{1}»',
  'Your payment for {0} arrived after the booking expired, so it is being refunded.': 'Оплата за «{0}» пришла после истечения брони, поэтому мы возвращаем деньги.',
  'Manual refund needed: {0} som for booking #{1}': 'Нужен ручной возврат: {0} сом по заказу №{1}',
  '{0} accepted your booking: {1}': '{0} принял(а) ваш заказ: {1}',
  "{0} can't make it, so we're finding you another verified pro": '{0} не сможет прийти. Ищем вам другого проверенного мастера',
  "Your pro cancelled, so we're finding you another verified pro for {1}": 'Мастер отменил заказ. Ищем другого проверенного мастера для «{1}»',
  '{0} has arrived and started the job': '{0} на месте и приступил(а) к работе',
  '{0} marked the job as done. Please confirm and release payment.': '{0} отметил(а) работу выполненной. Подтвердите, чтобы передать оплату.',
  'Payment released: {0} som': 'Оплата зачислена: {0} сом',
  'Your next {0} visit is reserved. Pay for it to confirm.': 'Следующий визит ({0}) забронирован. Оплатите его, чтобы подтвердить.',
  'The client reported a problem with {0}': 'Клиент сообщил о проблеме с заказом «{0}»', 'Dispute opened on booking #{0}': 'Открыт спор по заказу №{0}',
  'Booking cancelled: {0}. You receive a {1} som late-cancellation fee.': 'Заказ отменён: {0}. Вам начислена компенсация за позднюю отмену: {1} сом.',
  'Booking cancelled: {0}': 'Заказ отменён: {0}',
  "You've been refunded for {0}": 'Вам вернули деньги за «{0}»', "Dispute resolved in the client's favour: {0}": 'Спор решён в пользу клиента: {0}',
  'New {0}★ review from {1}': 'Новый отзыв {0}★ от {1}', '💬 New message from {0}': '💬 Новое сообщение от {0}',
  'New lead in {0}: {1}': 'Новая заявка ({0} р-н): {1}',
  'Updated quote from {0}: {1} som': 'Обновлённое предложение от {0}: {1} сом', 'New quote from {0}: {1} som': 'Новое предложение от {0}: {1} сом',
  '🎉 You are verified! You can now accept jobs.': '🎉 Вы прошли проверку! Теперь можно брать заказы.',
  'Verification was rejected. Please check your ID photos and try again.': 'Проверка не пройдена. Проверьте фото документов и попробуйте снова.',

  // sms + mock checkout
  'Usta code: {0}. Do not share it with anyone.': 'Код Usta: {0}. Никому его не сообщайте.',
  'Test payment': 'Тестовая оплата', 'Pay for booking': 'Оплата заказа', 'Tip': 'Чаевые', 'Pay': 'Оплатить', 'Simulate failed payment': 'Имитировать неудачную оплату',
  'Bank card (Elcart / Visa)': 'Банковская карта (Элкарт / Visa)',
  'Test mode: no real money is charged. In production this page is replaced by the O!Dengi / Mbank checkout.': 'Тестовый режим: деньги не списываются. В рабочей версии здесь будет страница оплаты O!Dengi / Mbank.',
};
const DICT = { ru: RU };

function tr(lang, s, params = []) {
  const d = DICT[lang] || {};
  return String((d[s] ?? s)).replace(/\{(\d+)\}/g, (_, i) => { const v = params?.[i]; return v == null ? '' : String(d[v] ?? v); });
}

module.exports = { tr, LANGS, RU };
