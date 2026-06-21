## Examples

### Basics - Hello World
```
VIBEMETHOD main()
	res = Hello, world!
	VIBERETURN(res)
```

### Basics - Function call
```
VIBEMETHOD main()
	res = VIBECALL mul(a = 3, my number = 9)
	VIBERETURN(res)

VIBEMETHOD mul(a: number, my number: number)
	n = a * my number
	VIBERETURN(n)
```

### Basics - Recursion
```
VIBEMETHOD main()
	res = VIBECALL fac(n = 4)
	VIBERETURN(res)

VIBEMETHOD fac(n: number)
	if n <= 1
        VIBERETURN(1)
    else
        subres = VIBECALL fac(n = n - 1)
        n = n * subres
	VIBERETURN(n)
```
