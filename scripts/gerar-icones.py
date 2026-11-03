# Gera public/icon-192.png, icon-512.png e icon-maskable-512.png (python3 + Pillow).
import math
from PIL import Image, ImageDraw

CIANO = (54, 224, 255)

def orbe(tam, escala):  # escala: fração do tamanho usada pelo desenho (maskable = zona segura)
    S = tam * 4
    img = Image.new('RGB', (S, S), (2, 5, 10))
    d = ImageDraw.Draw(img)
    c = S / 2
    for i in range(60):  # fundo radial
        r = S * 0.7 * (1 - i / 60)
        k = i / 60
        d.ellipse([c - r, c - r, c + r, c + r], fill=(int(2 + 8 * k), int(5 + 23 * k), int(10 + 32 * k)))
    u = S / 512 * escala

    def anel(r, w, cor=CIANO):
        r *= u; w *= u
        d.ellipse([c - r, c - r, c + r, c + r], outline=cor, width=max(1, int(w)))

    anel(170, 10)
    r = 125 * u  # anel tracejado
    for a in range(0, 360, 14):
        d.arc([c - r, c - r, c + r, c + r], a, a + 9, fill=(40, 170, 195), width=max(1, int(4 * u)))
    anel(80, 8)
    for i in range(30):  # miolo brilhante
        rr = 60 * u * (1 - i / 30)
        k = i / 30
        d.ellipse([c - rr, c - rr, c + rr, c + rr],
                  fill=(int(54 + 180 * k), int(224 + 31 * k), 255))
    return img.resize((tam, tam), Image.LANCZOS)

orbe(192, 1).save('public/icon-192.png')
orbe(512, 1).save('public/icon-512.png')
orbe(512, 0.72).save('public/icon-maskable-512.png')
