/* 用最小 Java 程序隔离问题：java.library.path 到底能不能加载 lwjgl.dll */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const base = join(process.env.TEMP, 'ieml-live-test');
const java = join(base, 'java', '17', 'jdk-17.0.20.1+1-jre', 'bin', 'java.exe');
const javac = join(base, 'java', '17', 'jdk-17.0.20.1+1-jre', 'bin', 'javac.exe');
const natives = join(base, 'instances', 'live-1.20.1', 'natives');
const work = join(base, 'probe');

console.log('java :', existsSync(java) ? 'OK' : '缺失', java);
console.log('javac:', existsSync(javac) ? 'OK' : '缺失（JRE 不带编译器）');

mkdirSync(work, { recursive: true });

const src = `
public class Probe {
    public static void main(String[] args) {
        System.out.println("== java.library.path ==");
        System.out.println(System.getProperty("java.library.path"));
        System.out.println();
        System.out.println("== os.arch ==");
        System.out.println(System.getProperty("os.arch"));
        System.out.println("== sun.arch.data.model ==");
        System.out.println(System.getProperty("sun.arch.data.model"));
        System.out.println();
        try {
            System.loadLibrary("lwjgl");
            System.out.println("RESULT: System.loadLibrary(\\"lwjgl\\") 成功");
        } catch (Throwable t) {
            System.out.println("RESULT: 失败 -> " + t);
        }
        // 再试绝对路径
        try {
            System.load(new java.io.File(args[0], "lwjgl.dll").getAbsolutePath());
            System.out.println("RESULT: System.load(绝对路径) 成功");
        } catch (Throwable t) {
            System.out.println("RESULT: 绝对路径也失败 -> " + t.getMessage());
        }
    }
}
`;
writeFileSync(join(work, 'Probe.java'), src, 'utf8');

// 用系统的 Java 25 编译（JRE 没编译器），再用 JRE 17 运行
const sysJava = 'C:\\Program Files\\Eclipse Adoptium\\jdk-25.0.3.9-hotspot\\bin';
console.log('\n=== 编译 ===');
try {
  execFileSync(join(sysJava, 'javac.exe'), ['-d', work, join(work, 'Probe.java')], { stdio: 'inherit' });
  console.log('编译成功');
} catch (e) {
  console.log('编译失败:', e.message);
  process.exit(1);
}

console.log('\n=== 用 JRE 17 运行（java.library.path = natives）===');
try {
  const out = execFileSync(java, ['-Djava.library.path=' + natives, '-cp', work, 'Probe', natives], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  console.log(out);
} catch (e) {
  console.log('STDOUT:', e.stdout);
  console.log('STDERR:', e.stderr);
}

console.log('\n=== 对照：用 Java 25 运行同一个程序 ===');
try {
  const out = execFileSync(join(sysJava, 'java.exe'), ['-Djava.library.path=' + natives, '-cp', work, 'Probe', natives], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  console.log(out);
} catch (e) {
  console.log('STDOUT:', e.stdout);
  console.log('STDERR:', e.stderr);
}
