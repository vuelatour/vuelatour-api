import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CalculateQuoteDto } from './dto/calculate-quote.dto';
import { QuotesService } from './quotes.service';

@ApiTags('Quotes')
@ApiBearerAuth()
@Controller({ path: 'quotes', version: '1' })
export class QuotesController {
  constructor(private readonly quotes: QuotesService) {}

  @Post('calculate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Compute a quote without persisting. Returns full breakdown (tiempos, tarifa, TUAS por aeropuerto, IVA, total USD).',
  })
  calculate(@Body() dto: CalculateQuoteDto) {
    return this.quotes.calculate(dto);
  }
}
