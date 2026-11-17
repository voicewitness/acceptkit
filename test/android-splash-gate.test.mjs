// 聚焦窗口名字带 Splash 只是嫌疑：画面层级里已经有被测包自己的控件，就是页面起来了（有的 App 首页 Feed 就挂在名字带 Splash 的 Activity 里）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dropSplashIfPageIsUp } from '../core/android-splash.mjs';

const PKG = 'com.example.app';
const splash = { name: '还停在启动页', splash: true };
const other = { name: '权限弹窗' };
const node = (text, clickable = true, pkg = PKG) => ({ text, clickable, pkg });

test('Feed 挂在 SplashActivity 里：有被测包的可点控件就撤掉启动页这一条', () => {
  const feed = [node('Video'), node('Like video. 6,234 likes'), node('Read or add comments'), node('Sound: original sound')];
  assert.deepEqual(dropSplashIfPageIsUp([splash], feed, PKG), []);
});

test('真的停在启动页（没有控件 / 只有别的包 / 不可点）时不撤', () => {
  assert.deepEqual(dropSplashIfPageIsUp([splash], [], PKG), [splash]);
  assert.deepEqual(dropSplashIfPageIsUp([splash], [node('a', true, 'android'), node('b', true, 'android'), node('c', true, 'android')], PKG), [splash]);
  assert.deepEqual(dropSplashIfPageIsUp([splash], [node('a', false), node('b', false), node('c', false)], PKG), [splash]);
});

test('别的遮蔽层不受影响', () => {
  const feed = [node('a'), node('b'), node('c')];
  assert.deepEqual(dropSplashIfPageIsUp([splash, other], feed, PKG), [other]);
});

test('Feed 底栏外层框可点、字在里面不可点：被测包 5 条以上不同的字也算页面起来了', () => {
  const feed = [node('Home', false), node('Friends', false), node('Inbox', false), node('Profile', false), node('#bmw 不是用来上路的…', false)];
  assert.deepEqual(dropSplashIfPageIsUp([splash], feed, PKG), []);
});

test('启动页上的广告寥寥几个字（跳过 / 广告 / 品牌名），重复的字不凑数：照样拒', () => {
  const ad = [node('跳过', false), node('广告', false), node('Brand', false), node('跳过', false), node('广告', false), node('Brand', false)];
  assert.deepEqual(dropSplashIfPageIsUp([splash], ad, PKG), [splash]);
});
