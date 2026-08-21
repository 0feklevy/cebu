import { describe, it, expect } from 'vitest';
import { captionsToPlainText, detectLanguage, CONFIDENT } from '../detectLanguage.js';
import { DUBBING_LANGUAGES } from '../languages.js';

/**
 * These samples are written the way a lesson transcript actually reads — a paragraph of connected
 * speech, not a word list — because that is the only input this detector is ever given, and a
 * detector tested on curated stopword soup would pass while failing on the real thing.
 */
const EN = `Welcome back everyone. In this lesson we are going to look at what happens when a
  system is pushed just past the point where it can settle down, and why that turns out to be the
  most interesting place to study it. You will see that the behaviour we get is not random, but it
  is also not something you could have predicted from the starting conditions alone. That is the
  idea we want to build up to, and once you have it you will start noticing it everywhere.`;

const ES = `Bienvenidos de nuevo a todos. En esta lección vamos a ver qué sucede cuando un sistema
  se empuja un poco más allá del punto en el que puede estabilizarse, y por qué ese resulta ser el
  lugar más interesante para estudiarlo. Verán que el comportamiento que obtenemos no es aleatorio,
  pero tampoco es algo que se pueda predecir solo con las condiciones iniciales. Esa es la idea que
  queremos construir, y cuando la tengan van a empezar a verla en todas partes.`;

const HE = `שלום לכולם וברוכים הבאים לשיעור. היום נבחן מה קורה כאשר מערכת נדחפת מעט מעבר לנקודה שבה
  היא יכולה להתייצב, ולמה דווקא שם נמצא המקום המעניין ביותר לחקור אותה. תראו שההתנהגות שאנחנו
  מקבלים אינה אקראית, אבל גם אי אפשר לחזות אותה רק מתוך תנאי ההתחלה. זו הרעיון שאנחנו רוצים לבנות
  כאן, וברגע שיהיה לכם, תתחילו לראות אותו בכל מקום.`;

const FR = `Bonjour à tous et bienvenue dans cette leçon. Nous allons voir ce qui se passe lorsque
  un système est poussé juste au-delà du point où il peut se stabiliser, et pourquoi c'est
  justement là que ça devient le plus intéressant à étudier. Vous verrez que le comportement que
  nous obtenons n'est pas aléatoire, mais qu'il n'est pas non plus prévisible à partir des
  conditions initiales. C'est cette idée que nous voulons construire ensemble aujourd'hui.`;

const RU = `Здравствуйте и добро пожаловать на этот урок. Сегодня мы посмотрим, что происходит,
  когда система выходит немного за пределы точки, в которой она может успокоиться, и почему именно
  это оказывается самым интересным местом для изучения. Вы увидите, что поведение, которое мы
  получаем, не случайно, но его также нельзя предсказать только из начальных условий.`;

const codes = new Set(DUBBING_LANGUAGES.map((l) => l.code));

describe('captionsToPlainText', () => {
  it('keeps the spoken words and drops everything WebVTT adds around them', () => {
    const vtt = [
      'WEBVTT',
      '',
      'NOTE This file was generated automatically',
      '',
      '1',
      '00:00:00.000 --> 00:00:03.500',
      '<v Ofek>Welcome back everyone.</v>',
      '',
      '2',
      '00:00:03.500 --> 00:00:07.000',
      '- In this lesson we look at chaos.',
      '',
    ].join('\n');
    const text = captionsToPlainText(vtt);
    expect(text).toContain('Welcome back everyone');
    expect(text).toContain('In this lesson we look at chaos');
    // The parts that would poison a token rate.
    expect(text).not.toContain('WEBVTT');
    expect(text).not.toContain('-->');
    expect(text).not.toContain('generated automatically');
    expect(text).not.toContain('<v');
  });

  it('is safe on null, empty and header-only input', () => {
    expect(captionsToPlainText(null)).toBe('');
    expect(captionsToPlainText('')).toBe('');
    expect(captionsToPlainText('WEBVTT\n').trim()).toBe('');
  });
});

describe('detectLanguage', () => {
  it.each([
    ['English', EN, 'en'],
    ['Spanish', ES, 'es'],
    ['French', FR, 'fr'],
    ['Hebrew', HE, 'he'],
    ['Russian', RU, 'ru'],
  ])('identifies %s confidently enough to act on', (_name, text, expected) => {
    const guess = detectLanguage(text);
    expect(guess).not.toBeNull();
    expect(guess!.code).toBe(expected);
    expect(guess!.confidence).toBeGreaterThanOrEqual(CONFIDENT);
  });

  it('still says Hebrew when the lesson is full of Latin technical terms', () => {
    const mixed = `${HE} השתמשנו כאן ב JavaScript ו React כדי לבנות את הסימולציה, והרצנו אותה עם
      Node.js על שרת רגיל. הקוד עצמו נמצא ב GitHub וכל אחד יכול להוריד אותו.`;
    const guess = detectLanguage(mixed);
    expect(guess?.code).toBe('he');
    expect(guess!.confidence).toBeGreaterThanOrEqual(CONFIDENT);
  });

  it('returns null rather than guessing on too little text', () => {
    expect(detectLanguage('Hello.')).toBeNull();
    expect(detectLanguage('')).toBeNull();
    expect(detectLanguage('The cat sat on the mat and then it left.')).toBeNull();
  });

  it('returns null for Latin text that matches no profile', () => {
    // Real letters, real token count, no function words of any language.
    const nonsense = Array.from({ length: 120 }, (_, i) => `zxq${i}vv`).join(' ');
    expect(detectLanguage(nonsense)).toBeNull();
  });

  it('never returns a code this product cannot dub into', () => {
    for (const text of [EN, ES, FR, HE, RU]) {
      const guess = detectLanguage(text);
      if (guess) expect(codes.has(guess.code)).toBe(true);
    }
  });

  it('reports a shared script it cannot narrow BELOW the acting threshold', () => {
    // Cyrillic letters with no Russian, Ukrainian or Bulgarian function words in them.
    const opaque = Array.from({ length: 80 }, () => 'жьщъ').join(' ');
    const guess = detectLanguage(opaque);
    expect(guess).not.toBeNull();
    expect(guess!.confidence).toBeLessThan(CONFIDENT);
  });
});
