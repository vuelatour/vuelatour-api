import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { TreasuryService } from './treasury.service';

@ApiTags('Treasury')
@ApiBearerAuth()
@Controller({ path: 'treasury', version: '1' })
export class TreasuryController {
  constructor(private readonly treasury: TreasuryService) {}

  @Get('dashboard')
  @ApiOperation({
    summary:
      'Treasury dashboard: account balances + spend per card (this month)',
  })
  dashboard() {
    return this.treasury.dashboard();
  }
}
