// ============================================================================
// ガリバー・プロステージ ver 6.2.0 同梱 .NET アセンブリ 逆コンパイル結果 (C# 再構成コード + IL)
// ============================================================================

using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Windows.Forms;
using System.Xml.Serialization;
using AsakawaSystems.Win.Common.File;
using AsakawaSystems.Win.Sirius.Information;

// ----------------------------------------------------------------------------
// 1. CallInstallBat.exe
// ----------------------------------------------------------------------------
namespace CallInstallBat
{
    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            if (args.Length == 0)
            {
                Console.WriteLine("コマンドライン引数はありません。");
                return;
            }
            string cmdArgs = string.Empty;
            foreach (string arg in args)
            {
                Console.WriteLine(arg);
                cmdArgs = cmdArgs + " " + arg;
            }
            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = "cmd.exe";
            psi.Arguments = "/c " + cmdArgs;
            Process proc = Process.Start(psi);
            proc.WaitForExit();
        }
    }
}

// ----------------------------------------------------------------------------
// 2. PackageCheck.exe
// ----------------------------------------------------------------------------
namespace PackageCheck
{
    internal class Program
    {
        private static void Main(string[] args)
        {
            try
            {
                Console.WriteLine("パッケージ種類のチェック中・・・");
                Check check = new Check();
                check.CheckPackage(args[0]);
                Console.WriteLine("チェック終了");
            }
            catch (Exception ex)
            {
                Console.WriteLine("エラーが発生しました。");
                Console.WriteLine(ex.ToString());
                Console.ReadLine();
            }
        }
    }

    public class Check
    {
        public bool CheckPackage(string selectedPath)
        {
            string packageKubun = this.openASKFile(selectedPath);
            this.writeIniFile(selectedPath, packageKubun);
            return true;
        }

        private string openASKFile(string selectedPath)
        {
            string askPath = Path.Combine(selectedPath, "ASK");
            // SystemConstant.EncryptionKey ("AsakawaSystems19840704") で DES 復号
            EncryptDecrypt.DecryptFile(askPath, SystemConstant.EncryptionKey);
            FileStream fs = File.OpenRead(askPath);
            StreamReader sr = new StreamReader(fs, Encoding.GetEncoding("sjis"));
            string grade = string.Empty;
            while (sr.Peek() >= 0)
            {
                string line = sr.ReadLine();
                if (line.Equals("[Grade]"))
                {
                    while (sr.Peek() >= 0)
                    {
                        line = sr.ReadLine();
                        if (!line.StartsWith("#"))
                        {
                            if (line.StartsWith("[")) break;
                            grade = line;
                            break;
                        }
                    }
                    break;
                }
            }
            sr.Close();
            fs.Close();
            // 再度 DES 暗号化して上書き保存
            EncryptDecrypt.EncryptFile(askPath, SystemConstant.EncryptionKey);
            return grade;
        }

        private void writeIniFile(string selectedPath, string packageKubun)
        {
            string iniPath = Path.Combine(selectedPath, "packageCheckTmp.ini");
            INI.Write("Result", "Check", packageKubun, iniPath);
        }
    }
}

// ----------------------------------------------------------------------------
// 3. AsakawaSystems.Win.Common.File.dll
// ----------------------------------------------------------------------------
namespace AsakawaSystems.Win.Common.File
{
    public class EncryptDecrypt
    {
        public static void EncryptFile(string fileName, string key)
        {
            EncryptFile(fileName, fileName, key);
        }

        public static void EncryptFile(string inFileName, string outFileName, string key)
        {
            FileStream inStream = new FileStream(inFileName, FileMode.Open, FileAccess.Read);
            StreamReader sr = new StreamReader(inStream, Encoding.GetEncoding("sjis"));
            string content = sr.ReadToEnd();
            sr.Close();
            inStream.Close();

            FileStream outStream = new FileStream(outFileName, FileMode.Create, FileAccess.Write);
            DESCryptoServiceProvider des = new DESCryptoServiceProvider();
            byte[] keyBytes = Encoding.UTF8.GetBytes(key);
            des.Key = ResizeBytesArray(keyBytes, des.Key.Length);
            des.IV  = ResizeBytesArray(keyBytes, des.IV.Length);
            ICryptoTransform encryptor = des.CreateEncryptor();
            CryptoStream cs = new CryptoStream(outStream, encryptor, CryptoStreamMode.Write);
            StreamWriter sw = new StreamWriter(cs, Encoding.GetEncoding("sjis"));
            sw.Write(content);
            sw.Flush();
            sw.Close();
            cs.Close();
            outStream.Close();
        }

        public static void DecryptFile(string fileName, string key)
        {
            DecryptFile(fileName, fileName, key);
        }

        public static void DecryptFile(string inFileName, string outFileName, string key)
        {
            DESCryptoServiceProvider des = new DESCryptoServiceProvider();
            byte[] keyBytes = Encoding.UTF8.GetBytes(key);
            des.Key = ResizeBytesArray(keyBytes, des.Key.Length);
            des.IV  = ResizeBytesArray(keyBytes, des.IV.Length);
            FileStream inStream = new FileStream(inFileName, FileMode.Open, FileAccess.Read);
            ICryptoTransform decryptor = des.CreateDecryptor();
            CryptoStream cs = new CryptoStream(inStream, decryptor, CryptoStreamMode.Read);
            StreamReader sr = new StreamReader(cs, Encoding.GetEncoding("sjis"));
            string plaintext = sr.ReadToEnd();
            sr.Close();
            cs.Close();
            inStream.Close();

            StreamWriter sw = new StreamWriter(outFileName, false, Encoding.GetEncoding("sjis"));
            sw.Write(plaintext);
            sw.Flush();
            sw.Close();
        }

        private static byte[] ResizeBytesArray(byte[] bytes, int newSize)
        {
            byte[] newBytes = new byte[newSize];
            if (bytes.Length <= newSize)
            {
                for (int i = 0; i < bytes.Length; i++) newBytes[i] = bytes[i];
            }
            else
            {
                int pos = 0;
                for (int i = 0; i < bytes.Length; i++)
                {
                    newBytes[pos++] ^= bytes[i];
                    if (pos >= newBytes.Length) pos = 0;
                }
            }
            return newBytes;
        }
    }
}
