from kstv.numfmt import format_value
from kstv.normalize import compare_display, parse_num, key_of


def test_number_formats():
    assert format_value(1234.5, '#,##0') == '1,235'
    assert format_value(1234.5, '$#,##0.00') == '$1,234.50'
    assert format_value(-1234.5, '$#,##0.00_);($#,##0.00)') == '($1,234.50)'
    assert format_value(0.0512, '0.0%') == '5.1%'
    assert format_value(1500000, '$#,##0,,"M"') == '$2M'
    assert format_value(45000, 'm/d/yyyy') == '3/15/2023'
    assert format_value(0.00123, '0.00E+00') == '1.23E-03'
    assert format_value(7, '0.0') == '7.0'


def test_comparison_semantics():
    assert compare_display('$8,684,689', '$8,684,689', 8684689.0).status == 'match'
    assert compare_display('2.40', '2.4', 2.4).status == 'format_only'          # formatting only
    assert compare_display('1,034', '1,035', 1034.6).status == 'mismatch'      # Word shows different rounding
    assert compare_display('572', '590', 590.0).status == 'mismatch'
    assert compare_display('5.1%', '5.12%', 0.0512).status != 'mismatch'      # displayed-precision rounding
    assert compare_display('-', '0.00', 0.0).status == 'match'                 # accounting dash == zero
    assert compare_display('Fee Simple', 'Fee simple').status == 'format_only'
    assert compare_display('Fee Simple', 'Leasehold').status == 'mismatch'
    assert compare_display('MF Rent', 'MF Rent Concessions').status == 'format_only'  # clipped label
    assert compare_display('MF Rent Concessions', 'MF Rent').status == 'mismatch'      # Word longer than Excel


def test_keys():
    assert key_of('$1,234') == key_of('1234') == 'n:1234'
    assert key_of('(17,876)') == 'n:-17876'
    assert parse_num('abc') is None
